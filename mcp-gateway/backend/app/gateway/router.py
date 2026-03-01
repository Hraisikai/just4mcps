"""
Gateway router — mounts the MCP protocol endpoints at /{slug}/mcp.

Supports both MCP transports:
  - POST /{slug}/mcp   Streamable HTTP (modern, preferred)
  - GET  /{slug}/mcp   SSE transport (legacy client compatibility)

Each request is authenticated and the tool view is scoped to the user's groups.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse, StreamingResponse
from sse_starlette.sse import EventSourceResponse

from app.auth.dependencies import CurrentUser, CurrentUserDep, get_current_user
from app.db import queries
from app.gateway.proxy import get_filtered_tools, proxy_tool_call
from app.gateway.upstream import upstream_pool

logger = logging.getLogger(__name__)

router = APIRouter(tags=["gateway"])

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

MCP_VERSION = "2024-11-05"


def _jsonrpc_result(id: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": id, "result": result}


def _jsonrpc_error(id: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}


async def _resolve_slug(slug: str) -> dict:
    server = await queries.get_mcp_server(slug)
    if not server or not server.get("enabled", True):
        raise HTTPException(status_code=404, detail=f"MCP server '{slug}' not found")
    return server


async def _handle_message(
    slug: str,
    user: CurrentUser,
    message: dict,
) -> dict:
    """Dispatch a single JSON-RPC MCP message and return the response dict."""
    method = message.get("method", "")
    msg_id = message.get("id")
    params = message.get("params", {})

    if method == "initialize":
        return _jsonrpc_result(
            msg_id,
            {
                "protocolVersion": MCP_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": f"mcp-gateway/{slug}", "version": "0.1.0"},
            },
        )

    if method == "notifications/initialized":
        # Notification — no response needed
        return {}

    if method == "tools/list":
        tools = await get_filtered_tools(slug, user)
        tool_dicts = [
            {
                "name": t.name,
                "description": t.description,
                "inputSchema": t.inputSchema if isinstance(t.inputSchema, dict)
                else t.inputSchema.model_dump(),
            }
            for t in tools
        ]
        return _jsonrpc_result(msg_id, {"tools": tool_dicts})

    if method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        if not tool_name:
            return _jsonrpc_error(msg_id, -32602, "Missing tool name")
        try:
            result = await proxy_tool_call(slug, user, tool_name, arguments)
            content = [
                c.model_dump() if hasattr(c, "model_dump") else c
                for c in result.content
            ]
            return _jsonrpc_result(msg_id, {"content": content, "isError": result.isError})
        except HTTPException as exc:
            return _jsonrpc_error(msg_id, -32000, exc.detail)

    # Unknown method
    return _jsonrpc_error(msg_id, -32601, f"Method not found: {method}")


# ---------------------------------------------------------------------------
# Streamable HTTP transport  (POST /{slug}/mcp)
# ---------------------------------------------------------------------------


@router.post("/{slug}/mcp")
async def streamable_http_endpoint(
    slug: str,
    request: Request,
    user: CurrentUserDep,
):
    await _resolve_slug(slug)

    body = await request.json()

    # Support both single message and batch
    is_batch = isinstance(body, list)
    messages = body if is_batch else [body]

    responses = []
    for msg in messages:
        resp = await _handle_message(slug, user, msg)
        if resp:  # notifications return {}
            responses.append(resp)

    if not responses:
        return Response(status_code=204)

    payload = responses if is_batch else responses[0]

    # If the client accepts SSE, stream the response (for future streaming tools)
    accept = request.headers.get("accept", "")
    if "text/event-stream" in accept:
        async def event_gen():
            data = json.dumps(payload)
            yield f"data: {data}\n\n"

        return StreamingResponse(event_gen(), media_type="text/event-stream")

    return JSONResponse(content=payload)


# ---------------------------------------------------------------------------
# SSE transport  (GET /{slug}/mcp)
# ---------------------------------------------------------------------------


@router.get("/{slug}/mcp")
async def sse_endpoint(
    slug: str,
    request: Request,
    user: CurrentUserDep,
):
    await _resolve_slug(slug)
    session_id = str(uuid.uuid4())
    post_url = f"/{slug}/mcp/messages/{session_id}"

    # Store session context (sub, groups, slug, created_at) so the POST handler can look it up
    request.app.state.sse_sessions = getattr(request.app.state, "sse_sessions", {})
    request.app.state.sse_sessions[session_id] = {
        "slug": slug,
        "sub": user.subject,
        "groups": user.groups,
        "queue": [],
        "created_at": time.time(),
    }

    async def event_gen():
        # Send the endpoint event — client uses this URL to POST messages
        yield {"event": "endpoint", "data": post_url}

        # Keep the SSE stream alive while the client is connected
        session_store = request.app.state.sse_sessions
        try:
            while True:
                session = session_store.get(session_id)
                if not session:
                    break
                while session["queue"]:
                    msg = session["queue"].pop(0)
                    yield {"event": "message", "data": json.dumps(msg)}
                await asyncio.sleep(0.1)
        finally:
            session_store.pop(session_id, None)

    return EventSourceResponse(event_gen())


@router.post("/{slug}/mcp/messages/{session_id}")
async def sse_message_endpoint(
    slug: str,
    session_id: str,
    request: Request,
    user: CurrentUserDep,
):
    """Receive messages from SSE-transport clients and push responses back."""
    session_store = getattr(request.app.state, "sse_sessions", {})
    session = session_store.get(session_id)
    if not session or session["slug"] != slug:
        raise HTTPException(status_code=404, detail="Session not found")

    # Session isolation: verify this session belongs to the current user
    if session["sub"] != user.subject:
        raise HTTPException(status_code=403, detail="Session belongs to another user")

    body = await request.json()
    messages = body if isinstance(body, list) else [body]

    for msg in messages:
        # Use freshly authenticated user (not stale session groups)
        resp = await _handle_message(slug, user, msg)
        if resp:
            session["queue"].append(resp)

    return Response(status_code=202)
