"""
Admin endpoints for managing group → tool permissions.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.auth.dependencies import AdminUserDep
from app.config import settings
from app.db import queries

router = APIRouter(tags=["admin/permissions"])


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class GrantRequest(BaseModel):
    group: str
    tool_name: str


class RevokeRequest(BaseModel):
    group: str
    tool_name: str


class BulkSetRequest(BaseModel):
    """Replace a group's permissions on a given MCP wholesale."""
    group: str
    tool_names: list[str]


# ---------------------------------------------------------------------------
# Per-MCP permission management
# ---------------------------------------------------------------------------


@router.get("/mcps/{slug}/permissions")
async def list_mcp_permissions(slug: str, user: AdminUserDep):
    """All group→tool bindings for a given MCP server."""
    server = await queries.get_mcp_server(slug)
    if not server:
        raise HTTPException(status_code=404, detail=f"MCP server '{slug}' not found")
    rows = await queries.list_permissions_for_server(slug)
    # Normalise DB field names to the shape the frontend expects:
    # SurrealDB stores 'group_path'; frontend Permission interface uses 'group'.
    return [
        {"group": r["group_path"], "tool_name": r["tool_name"]}
        for r in rows
    ]


@router.post("/mcps/{slug}/permissions/grant", status_code=status.HTTP_201_CREATED)
async def grant_permission(slug: str, body: GrantRequest, user: AdminUserDep):
    server = await queries.get_mcp_server(slug)
    if not server:
        raise HTTPException(status_code=404, detail=f"MCP server '{slug}' not found")

    result = await queries.grant_permission(slug, body.tool_name, body.group, user.subject)
    return result


@router.post("/mcps/{slug}/permissions/revoke", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_permission(slug: str, body: RevokeRequest, user: AdminUserDep):
    server = await queries.get_mcp_server(slug)
    if not server:
        raise HTTPException(status_code=404, detail=f"MCP server '{slug}' not found")

    await queries.revoke_permission(slug, body.tool_name, body.group)


@router.put("/mcps/{slug}/permissions/bulk")
async def bulk_set_permissions(slug: str, body: BulkSetRequest, user: AdminUserDep):
    """
    Replace a group's permissions on this MCP wholesale.
    Send the full desired set of tool_names — anything not in the list is revoked.
    """
    server = await queries.get_mcp_server(slug)
    if not server:
        raise HTTPException(status_code=404, detail=f"MCP server '{slug}' not found")

    await queries.bulk_set_permissions(slug, body.group, body.tool_names, user.subject)
    return {"slug": slug, "group": body.group, "tool_names": body.tool_names}


# ---------------------------------------------------------------------------
# Per-group permission view
# ---------------------------------------------------------------------------


@router.get("/groups")
async def list_groups(user: AdminUserDep):
    """Return all known groups, sourced from settings.admin_groups.

    Groups are defined at deploy time (they were created in Keycloak to begin
    with), so we read them from config rather than discovering them from the
    can_use table. This means all groups are always visible for permission
    assignment, even before any permissions have been granted.

    Returns Group objects ({ path: string }) so the frontend can consume them
    without extra mapping.
    """
    return [{"path": g} for g in sorted(settings.admin_groups)]


@router.get("/groups/{group_path:path}/permissions")
async def list_group_permissions(group_path: str, user: AdminUserDep):
    """All tools a specific group can access, across all MCP servers.

    The frontend URL-encodes the leading slash (e.g. %2Fdevelopers → developers
    after server URL normalisation), so we add exactly one leading slash back.

    Returns the shape the frontend expects:
      { group: string, permissions: [{ mcp_slug: string, tools: string[] }] }
    """
    normalised = "/" + group_path.lstrip("/")

    rows = await queries.list_permissions_for_group(normalised)

    # Fold the flat [{mcp_slug, tool_name, ...}] list into the grouped structure
    by_mcp: dict[str, list[str]] = {}
    for row in rows:
        slug = row["mcp_slug"]
        by_mcp.setdefault(slug, []).append(row["tool_name"])

    return {
        "group": normalised,
        "permissions": [
            {"mcp_slug": slug, "tools": tools}
            for slug, tools in sorted(by_mcp.items())
        ],
    }
