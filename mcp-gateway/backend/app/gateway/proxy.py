"""
MCP protocol proxy logic.

Handles the two operations the gateway intercepts:
  - tools/list  → filtered against the user's effective permissions
  - tools/call  → permission check then forwarded to upstream session
"""

from __future__ import annotations

import httpx
import json
import logging
from typing import Any

from fastapi import HTTPException, status
from mcp.types import CallToolResult, Tool

from app.auth.dependencies import CurrentUser
from app.config import settings
from app.db import queries
from app.gateway.upstream import upstream_pool
from app.security.credentials import decrypt_credential

logger = logging.getLogger(__name__)


async def get_filtered_tools(slug: str, user: CurrentUser) -> list[Tool]:
    """
    Return the MCP Tool objects the user is allowed to see/call on this server.
    Pulls from SurrealDB (which is kept in sync by the upstream pool).

    If the user is a superuser, returns all tools for the server.
    Otherwise, filters by the user's group permissions.
    """
    # Superuser bypass: return all tools
    if any(g in user.groups for g in settings.superuser_groups):
        rows = await queries.list_tools_for_server(slug)
    else:
        # Regular user: filter by group permissions
        rows = await queries.get_effective_tools(slug, user.groups)

    tools = []
    for row in rows:
        schema = row.get("input_schema") or {"type": "object", "properties": {}}
        tools.append(
            Tool(
                name=row["tool_name"],
                description=row.get("description") or "",
                inputSchema=schema,
            )
        )
    return tools


async def proxy_tool_call(
    slug: str,
    user: CurrentUser,
    tool_name: str,
    arguments: dict[str, Any],
) -> CallToolResult:
    """
    Permission-check then forward a tool/call to the upstream.

    Raises HTTP 403 if the user doesn't have access to this tool.
    Raises HTTP 503 if the upstream is unavailable.
    Raises HTTP 404 if the tool doesn't exist on this server.
    Raises HTTP 403 with detail="credentials_required" if the tool requires
        user credentials but none are stored.
    Raises HTTP 403 with detail="credentials_invalid" if the upstream rejects
        the stored credential (expired, revoked, or rotated PAT).
    """
    # Permission check — query is cheap, avoids relying on client to only
    # send tools from the filtered list (defence in depth)
    is_superuser = any(g in user.groups for g in settings.superuser_groups)

    if is_superuser:
        # Superuser: skip permission check, all tools allowed
        pass
    else:
        # Regular user: check group permissions
        effective = await queries.get_effective_tools(slug, user.groups)
        allowed_names = {row["tool_name"] for row in effective}
        if tool_name not in allowed_names:
            # Don't leak whether the tool exists — just 403
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Not authorised to call tool '{tool_name}' on '{slug}'",
            )

    # Get MCP server config (for requires_user_credential flag)
    mcp_server = await queries.get_mcp_server(slug)
    if not mcp_server:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"MCP server '{slug}' not found",
        )

    # Resolve auth headers for this call.
    #
    # Priority (highest wins):
    #   1. requires_user_credential  → stored PAT, decrypted per-user
    #   2. forward_user_token        → caller's Keycloak JWT passed straight through
    #   3. static upstream auth      → bearer / header configured on the upstream
    entry = upstream_pool.get_entry(slug)
    auth_headers: dict[str, str] = {}
    using_forwarded_token = False

    if mcp_server.get("requires_user_credential"):
        # Lookup user's stored PAT for this MCP
        encrypted_cred = await queries.get_user_credential(user.subject, slug)
        if not encrypted_cred:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="credentials_required",
            )
        try:
            decrypted = decrypt_credential(encrypted_cred)
            auth_headers = {"Authorization": f"Bearer {decrypted}"}
        except Exception as exc:
            logger.error("Failed to decrypt credential for %s::%s: %s", user.subject, slug, exc)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="credentials_required",
            )
    elif entry and entry.auth and entry.auth.get("type") == "forward_user_token":
        # Same-OIDC upstream: forward the caller's JWT directly.
        # The user gets exactly their own permissions on the upstream — no
        # privilege escalation, no shared service account.
        auth_headers = {"Authorization": f"Bearer {user.raw_token}"}
        using_forwarded_token = True
    elif entry:
        auth_headers = entry.auth_headers()

    # Whether this call is using the user's personal credential (vs service-level auth)
    using_user_credential = mcp_server.get("requires_user_credential", False)

    # Get upstream session — stateless forward_user_token upstreams have no
    # persistent session; skip the check and let the streamable_http branch
    # handle the call directly.
    is_stateless = entry is not None and entry.is_stateless
    session = upstream_pool.get_session(slug)
    if session is None and not is_stateless:
        upstream_status = upstream_pool.get_status(slug)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Upstream '{slug}' is not available ({upstream_status['status']})",
        )

    # ------------------------------------------------------------------
    # Route the call to the upstream
    # ------------------------------------------------------------------
    #
    # Two paths:
    #   A) Direct HTTP — for upstreams that need per-user auth headers:
    #      requires_user_credential (stored PAT) or forward_user_token
    #      (caller's JWT).  We can't reuse the shared session because it
    #      was initialised without user-level auth.
    #   B) Session — everything else.  The shared MCP session is already
    #      initialized; session.call_tool() works for all transports.

    use_direct_http = (using_user_credential or using_forwarded_token) and entry and entry.transport == "streamable_http"

    if use_direct_http:
        try:
            headers = {
                **auth_headers,
                "X-Forwarded-User": user.subject,
                "X-Forwarded-Email": user.email or "",
                "X-Forwarded-Groups": ",".join(user.groups),
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            }

            async with httpx.AsyncClient() as client:
                # 1. Initialize a fresh MCP session with the user's PAT
                init_body = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "mcp-gateway", "version": "0.1.0"},
                    },
                }
                init_resp = await client.post(entry.url, json=init_body, headers=headers, timeout=15)
                session_id = init_resp.headers.get("mcp-session-id")

                call_headers = {**headers}
                if session_id:
                    call_headers["Mcp-Session-Id"] = session_id

                # 2. Notify initialized
                await client.post(
                    entry.url,
                    json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                    headers=call_headers,
                    timeout=5,
                )

                # 3. tools/call
                call_body = {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": tool_name, "arguments": arguments},
                }
                resp = await client.post(entry.url, json=call_body, headers=call_headers, timeout=30)

            if not resp.is_success:
                if resp.status_code in (401, 403):
                    if using_user_credential:
                        logger.warning(
                            "Upstream rejected stored PAT for %s::%s (HTTP %s)",
                            user.subject, slug, resp.status_code,
                        )
                        await queries.mark_credential_invalid(user.subject, slug)
                        raise HTTPException(
                            status_code=status.HTTP_403_FORBIDDEN,
                            detail="credentials_invalid",
                        )
                    else:
                        logger.warning(
                            "Upstream rejected forwarded token for %s::%s (HTTP %s)",
                            user.subject, slug, resp.status_code,
                        )
                        raise HTTPException(
                            status_code=status.HTTP_403_FORBIDDEN,
                            detail="Upstream rejected your credentials",
                        )
                logger.error(
                    "Upstream HTTP error for %s::%s: status=%s",
                    slug, tool_name, resp.status_code,
                )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Upstream error",
                )

            # streamable_http upstreams respond with text/event-stream even for
            # single-shot tool calls.  Parse the first data: line; fall back to
            # treating the body as plain JSON for servers that respond that way.
            content_type = resp.headers.get("content-type", "")
            if "text/event-stream" in content_type:
                payload = None
                for line in resp.text.splitlines():
                    if line.startswith("data: "):
                        try:
                            payload = json.loads(line[6:])
                        except Exception:
                            pass
                        break
                if payload is None:
                    logger.error("Empty or unparseable SSE response for %s::%s", slug, tool_name)
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail="Upstream error",
                    )
            else:
                payload = resp.json()

            # jsonrpc-level errors arrive as HTTP 200 with an "error" key —
            # surface them as isError=True content so the caller sees them.
            if "error" in payload:
                err = payload["error"]
                err_msg = err.get("message", str(err))
                if using_user_credential and any(
                    hint in err_msg.lower()
                    for hint in ("401", "403", "unauthorized", "forbidden")
                ):
                    logger.warning(
                        "Upstream returned jsonrpc 401/403 for %s::%s — marking credential invalid",
                        user.subject, slug,
                    )
                    await queries.mark_credential_invalid(user.subject, slug)
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="credentials_invalid",
                    )
                return CallToolResult(
                    content=[{"type": "text", "text": f"Error: {err_msg}"}],
                    isError=True,
                )

            result_data = payload.get("result", {})
            return CallToolResult(
                content=result_data.get("content", []),
                isError=result_data.get("isError", False),
            )

        except httpx.RequestError as exc:
            logger.error("Upstream request failed for %s::%s: %s", slug, tool_name, exc)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY, detail="Upstream error",
            )
        except HTTPException:
            raise
        except Exception as exc:
            logger.error("Tool call failed for %s::%s: %s", slug, tool_name, exc)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY, detail="Upstream error",
            )
    else:
        # Session path — shared, already-initialised MCP session.
        try:
            result = await session.call_tool(tool_name, arguments)
            return result
        except Exception as exc:
            exc_str = str(exc).lower()
            if using_user_credential and any(
                hint in exc_str
                for hint in ("401", "403", "unauthorized", "forbidden", "invalid token", "token expired")
            ):
                logger.warning(
                    "Upstream auth failure for %s::%s — credential may be expired: %s",
                    user.subject, slug, exc,
                )
                await queries.mark_credential_invalid(user.subject, slug)
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="credentials_invalid",
                ) from exc
            logger.error("Tool call failed for %s::%s: %s", slug, tool_name, exc)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Upstream error",
            ) from exc
