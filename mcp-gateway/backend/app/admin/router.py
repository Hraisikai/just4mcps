"""
Admin API root router.
All routes require the admin group. Individual sub-routers handle their own
path prefixes for clarity.
"""

from fastapi import APIRouter

from app.admin import mcps, permissions, connector
from app.auth.dependencies import AdminUserDep
from app.db import queries
from app.gateway.upstream import upstream_pool

router = APIRouter(tags=["admin"])


# Mount sub-routers
router.include_router(mcps.router)
router.include_router(permissions.router)
router.include_router(connector.router)


@router.get("/status")
async def gateway_status(user: AdminUserDep):
    """Overview of all upstream connection statuses."""
    all_statuses = upstream_pool.all_statuses()
    # Convert to the frontend's expected format with name and url
    upstreams = []
    for slug, status_info in all_statuses.items():
        server = await queries.get_mcp_server(slug)
        if server:
            upstreams.append({
                "name": server.get("name", slug),
                "url": server.get("upstream_url", ""),
                "status": status_info.get("status", "unknown"),
                "failure_count": status_info.get("failure_count", 0),
            })

    return {
        "upstreams": upstreams,
        "mcp_count": len(upstream_pool._entries),
        "status": "ok",
    }
