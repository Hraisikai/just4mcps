import asyncio
import contextlib
import logging
import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db.client import db
from app.db import queries
from app.gateway.router import router as gateway_router
from app.gateway.upstream import upstream_pool
from app.admin.router import router as admin_router
from app.admin.credentials import router as credentials_router
from app.auth.router import router as auth_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def _cleanup_stale_sessions(app_state) -> None:
    """Remove SSE sessions older than 3600 seconds."""
    session_store = getattr(app_state, "sse_sessions", {})
    now = time.time()
    stale_ids = [
        sid
        for sid, session in list(session_store.items())
        if now - session.get("created_at", 0) > 3600
    ]
    for sid in stale_ids:
        session_store.pop(sid, None)
        logger.debug("Cleaned up stale SSE session: %s", sid)


async def _sse_cleanup_loop(app_state) -> None:
    """Periodic cleanup of stale SSE sessions every 5 minutes."""
    while True:
        try:
            await asyncio.sleep(300)  # 5 minutes
            await _cleanup_stale_sessions(app_state)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.warning("SSE cleanup task error: %s", exc)


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    # Connect to SurrealDB and ensure schema exists
    await db.connect()
    await db.ensure_schema()
    logger.info("SurrealDB connected and schema verified")

    # Re-hydrate the upstream pool from persisted MCP server registrations.
    # This is critical on pod restarts — without it the in-memory pool is empty
    # and all tool calls will 503 until servers are manually refreshed.
    servers = await queries.list_mcp_servers()
    enabled_servers = [s for s in servers if s.get("enabled", True)]
    logger.info("Re-hydrating upstream pool with %d registered servers", len(enabled_servers))

    for server in enabled_servers:
        try:
            await upstream_pool.register(
                server["slug"],
                server["upstream_url"],
                server["transport"],
                server.get("upstream_auth"),
            )
        except Exception as exc:
            logger.warning("Failed to register upstream '%s' on startup: %s", server["slug"], exc)

    # Start upstream health check background task
    await upstream_pool.start()
    logger.info("Upstream connection pool started")

    # Start SSE cleanup background task
    cleanup_task = asyncio.create_task(_sse_cleanup_loop(app.state), name="sse-cleanup")
    logger.info("SSE cleanup task started")

    yield

    # Graceful shutdown
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass
    await upstream_pool.stop()
    await db.close()
    logger.info("Shutdown complete")


app = FastAPI(
    title="MCP Gateway",
    description="Keycloak-authenticated MCP gateway with per-group tool access control",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(credentials_router)
app.include_router(gateway_router)
app.include_router(admin_router, prefix="/admin")


@app.get("/healthz", tags=["meta"])
async def health():
    return {"status": "ok"}
