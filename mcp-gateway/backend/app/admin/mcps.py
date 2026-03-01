"""
Admin endpoints for MCP server registration and management.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, field_validator

from app.auth.dependencies import AdminUserDep
from app.db import queries
from app.gateway.upstream import upstream_pool

router = APIRouter(prefix="/mcps", tags=["admin/mcps"])


def _slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9-]", "-", name.lower().strip()).strip("-")


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class UpstreamAuth(BaseModel):
    type: str  # "bearer" | "header" | "none" | "forward_user_token"
    token: str | None = None   # bearer: static token; forward_user_token: optional service-account token for health/tool-sync
    header: str | None = None  # header auth: header name
    value: str | None = None   # header auth: header value

    @field_validator("type")
    @classmethod
    def validate_type(cls, v: str) -> str:
        allowed = {"bearer", "header", "none", "forward_user_token"}
        if v not in allowed:
            raise ValueError(f"auth type must be one of: {', '.join(sorted(allowed))}")
        return v


class RegisterMCPRequest(BaseModel):
    name: str
    description: str | None = None
    upstream_url: str
    transport: str = "streamable_http"
    upstream_auth: UpstreamAuth | None = None
    slug: str | None = None  # auto-derived from name if omitted
    requires_user_credential: bool = False
    credential_url: str | None = None  # URL where users can generate a new credential (e.g. GitLab PAT page)

    @field_validator("transport")
    @classmethod
    def validate_transport(cls, v: str) -> str:
        if v not in ("streamable_http", "sse", "stdio"):
            raise ValueError("transport must be streamable_http, sse, or stdio")
        return v

    def resolved_slug(self) -> str:
        return self.slug or _slugify(self.name)


class UpdateMCPRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    upstream_url: str | None = None
    transport: str | None = None
    upstream_auth: UpstreamAuth | None = None
    enabled: bool | None = None
    requires_user_credential: bool | None = None
    credential_url: str | None = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("")
async def list_mcps(user: AdminUserDep):
    servers = await queries.list_mcp_servers()
    for s in servers:
        upstream_status = upstream_pool.get_status(s["slug"])
        s["status"] = upstream_status.get("status", "unknown")
        s["failure_count"] = upstream_status.get("failure_count", 0)
        s["last_error"] = upstream_status.get("error")
        tools = await queries.list_tools_for_server(s["slug"])
        s["tool_count"] = len(tools)
    return servers


@router.post("", status_code=status.HTTP_201_CREATED)
async def register_mcp(body: RegisterMCPRequest, user: AdminUserDep):
    slug = body.resolved_slug()

    existing = await queries.get_mcp_server(slug)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"MCP server with slug '{slug}' already exists",
        )

    auth_dict = body.upstream_auth.model_dump() if body.upstream_auth else None

    # Register upstream (validates SSRF)
    try:
        await upstream_pool.register(slug, body.upstream_url, body.transport, auth_dict)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(e),
        )

    server = await queries.create_mcp_server(
        {
            "slug": slug,
            "name": body.name,
            "description": body.description,
            "upstream_url": body.upstream_url,
            "transport": body.transport,
            "upstream_auth": auth_dict,
            "enabled": True,
            "requires_user_credential": body.requires_user_credential,
            "credential_url": body.credential_url,
        }
    )

    return server


@router.get("/{slug}")
async def get_mcp(slug: str, user: AdminUserDep):
    server = await queries.get_mcp_server(slug)
    if not server:
        raise HTTPException(status_code=404, detail=f"MCP server '{slug}' not found")
    upstream_status = upstream_pool.get_status(slug)
    server["status"] = upstream_status.get("status", "unknown")
    server["failure_count"] = upstream_status.get("failure_count", 0)
    server["last_error"] = upstream_status.get("error")
    tools = await queries.list_tools_for_server(slug)
    server["tool_count"] = len(tools)
    server["tools"] = tools
    return server


@router.patch("/{slug}")
async def update_mcp(slug: str, body: UpdateMCPRequest, user: AdminUserDep):
    server = await queries.get_mcp_server(slug)
    if not server:
        raise HTTPException(status_code=404, detail=f"MCP server '{slug}' not found")

    updates = body.model_dump(exclude_none=True)
    if "upstream_auth" in updates and updates["upstream_auth"]:
        updates["upstream_auth"] = body.upstream_auth.model_dump()

    updated = await queries.update_mcp_server(slug, updates)

    # If URL/transport/auth changed, reconnect
    needs_reconnect = any(k in updates for k in ("upstream_url", "transport", "upstream_auth", "enabled"))
    if needs_reconnect and updated and updated.get("enabled"):
        await upstream_pool.register(
            slug,
            updated.get("upstream_url", server["upstream_url"]),
            updated.get("transport", server["transport"]),
            updated.get("upstream_auth", server.get("upstream_auth")),
        )
    elif needs_reconnect and updated and not updated.get("enabled"):
        await upstream_pool.unregister(slug)

    return updated


@router.delete("/{slug}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_mcp(slug: str, user: AdminUserDep):
    server = await queries.get_mcp_server(slug)
    if not server:
        raise HTTPException(status_code=404, detail=f"MCP server '{slug}' not found")

    await upstream_pool.unregister(slug)
    await queries.delete_mcp_server(slug)


@router.post("/{slug}/refresh", status_code=status.HTTP_202_ACCEPTED)
async def refresh_tools(slug: str, user: AdminUserDep):
    """Trigger a background reconnect + tool re-fetch for the upstream.

    Returns 202 immediately — the reconnect and tool sync run asynchronously.
    Poll GET /{slug}/tools or GET /{slug} to see the updated tool list once
    the connection succeeds.
    """
    server = await queries.get_mcp_server(slug)
    if not server:
        raise HTTPException(status_code=404, detail=f"MCP server '{slug}' not found")

    await upstream_pool.refresh(slug)
    return {"slug": slug, "status": "refreshing"}


@router.get("/{slug}/tools")
async def list_tools(slug: str, user: AdminUserDep):
    server = await queries.get_mcp_server(slug)
    if not server:
        raise HTTPException(status_code=404, detail=f"MCP server '{slug}' not found")
    rows = await queries.list_tools_for_server(slug)
    # Normalise DB field names to the shape the frontend expects:
    # SurrealDB stores 'tool_name'; frontend Tool interface uses 'name'.
    return [
        {"name": r["tool_name"], "description": r.get("description")}
        for r in rows
    ]
