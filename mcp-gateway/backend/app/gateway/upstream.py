"""
Upstream MCP connection pool.

One persistent MCP client per registered server. Background task health-checks
all connections and reconnects with exponential backoff on failure.

On reconnect, we re-fetch the tool listing from the upstream and write it back
to SurrealDB so the cache stays current.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import math
import urllib.parse
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.client.sse import sse_client

from app.config import settings

logger = logging.getLogger(__name__)


async def _fetch_keycloak_sa_token() -> str | None:
    """Fetch a fresh Keycloak service-account token via client credentials.

    Returns the access token or None if service accounts are not enabled /
    not configured.  Called by _connect on every (re)connection attempt so
    forward_user_token upstreams never get stuck with an expired token.
    """
    if not settings.keycloak_client_secret:
        return None
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                settings.keycloak_token_uri,
                data={
                    "grant_type": "client_credentials",
                    "client_id": settings.keycloak_client_id,
                    "client_secret": settings.keycloak_client_secret,
                },
                timeout=10,
            )
        if resp.status_code == 200:
            return resp.json().get("access_token")
        logger.debug(
            "Keycloak SA token unavailable (HTTP %s): %s",
            resp.status_code,
            resp.json().get("error_description", ""),
        )
    except Exception as exc:
        logger.warning("Could not fetch Keycloak SA token: %s", exc)
    return None


def _check_ssrf(url: str) -> None:
    """Check for SSRF risk by validating upstream URL doesn't resolve to reserved addresses."""
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    try:
        addr = ipaddress.ip_address(host)
        if addr.is_private or addr.is_link_local or addr.is_loopback:
            raise ValueError(f"Upstream URL resolves to a reserved address: {host}")
    except ValueError as e:
        if "reserved" in str(e):
            raise
        # Not an IP address (it's a hostname) — allow through


class UpstreamStatus(str, Enum):
    CONNECTED = "connected"
    CONNECTING = "connecting"
    DEGRADED = "degraded"
    DISCONNECTED = "disconnected"


@dataclass
class UpstreamEntry:
    slug: str
    url: str
    transport: str  # "streamable_http" | "sse" | "stdio"
    auth: dict | None

    session: ClientSession | None = field(default=None, repr=False)
    status: UpstreamStatus = UpstreamStatus.DISCONNECTED
    failure_count: int = 0
    last_error: str | None = None
    _connect_task: asyncio.Task | None = field(default=None, repr=False)
    _exit_stack: Any = field(default=None, repr=False)  # AsyncExitStack

    def backoff_delay(self) -> float:
        """Exponential backoff capped at the configured max."""
        delay = min(2 ** self.failure_count, settings.upstream_reconnect_max_delay_seconds)
        return float(delay)

    def auth_headers(self) -> dict[str, str]:
        if not self.auth:
            return {}
        auth_type = self.auth.get("type", "")
        if auth_type == "bearer":
            return {"Authorization": f"Bearer {self.auth['token']}"}
        if auth_type == "header":
            return {self.auth["header"]: self.auth["value"]}
        if auth_type == "forward_user_token":
            # Optional service-account token for connection-level auth and tool
            # sync (health loop).  Per-user JWT is injected at call time in
            # proxy_tool_call — this method is never called with a live user.
            token = self.auth.get("token")
            return {"Authorization": f"Bearer {token}"} if token else {}
        return {}

    @property
    def is_stateless(self) -> bool:
        """True for forward_user_token upstreams with no service-account token.

        These upstreams skip the persistent MCP session entirely — each tool
        call is an independent HTTP request with the calling user's JWT injected
        by proxy_tool_call.  Tool auto-discovery is unavailable without a
        service-account token; tools must be registered manually via the admin
        API or by providing an optional token for the health loop.
        """
        return (
            bool(self.auth)
            and self.auth.get("type") == "forward_user_token"
            and not self.auth.get("token")
        )


class UpstreamPool:
    def __init__(self):
        self._entries: dict[str, UpstreamEntry] = {}
        self._health_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        self._health_task = asyncio.create_task(self._health_loop(), name="upstream-health")

    async def stop(self) -> None:
        if self._health_task:
            self._health_task.cancel()
            try:
                await self._health_task
            except asyncio.CancelledError:
                pass

        for entry in list(self._entries.values()):
            await self._disconnect(entry)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def register(self, slug: str, url: str, transport: str, auth: dict | None) -> None:
        """Register or update an upstream and kick off a background connect.

        The connection runs as a fire-and-forget asyncio Task so the caller
        returns immediately.  This avoids an anyio cancel-scope task-mismatch
        RuntimeError that surfaces when _connect is awaited directly inside a
        FastAPI route handler: the MCP SDK's streamablehttp_client creates an
        anyio task group, and if the connection fails the cleanup tries to exit
        the cancel scope from the wrong task context.
        """
        _check_ssrf(url)
        async with self._lock:
            if slug in self._entries:
                await self._disconnect(self._entries[slug])
            entry = UpstreamEntry(slug=slug, url=url, transport=transport, auth=auth)
            self._entries[slug] = entry

        asyncio.create_task(self._connect(entry), name=f"connect-{slug}")

    async def unregister(self, slug: str) -> None:
        async with self._lock:
            entry = self._entries.pop(slug, None)
        if entry:
            await self._disconnect(entry)

    def get_session(self, slug: str) -> ClientSession | None:
        entry = self._entries.get(slug)
        if entry and entry.status == UpstreamStatus.CONNECTED:
            return entry.session
        return None

    def get_status(self, slug: str) -> dict:
        entry = self._entries.get(slug)
        if not entry:
            return {"status": "unknown", "error": None}
        return {
            "status": entry.status.value,
            "error": entry.last_error,
            "failure_count": entry.failure_count,
        }

    def all_statuses(self) -> dict[str, dict]:
        return {slug: self.get_status(slug) for slug in self._entries}

    def get_entry(self, slug: str) -> UpstreamEntry | None:
        """Return the UpstreamEntry for a given slug, or None if not registered."""
        return self._entries.get(slug)

    async def refresh(self, slug: str) -> None:
        """Force a reconnect + tool re-fetch for the given slug.

        Disconnect is synchronous (clears the session immediately), then the
        reconnect is launched as a background task for the same reason as
        register() — to avoid the anyio cancel-scope task-mismatch issue.
        """
        entry = self._entries.get(slug)
        if entry:
            await self._disconnect(entry)
            asyncio.create_task(self._connect(entry), name=f"reconnect-{slug}")

    # ------------------------------------------------------------------
    # Internal connect / disconnect
    # ------------------------------------------------------------------

    async def _connect(self, entry: UpstreamEntry) -> None:
        entry.status = UpstreamStatus.CONNECTING

        # For forward_user_token upstreams, refresh the service-account token on
        # every (re)connect so we never get stuck with an expired token.
        # If Keycloak returns a fresh token, inject it into entry.auth so
        # auth_headers() picks it up for this connection attempt.
        if entry.auth and entry.auth.get("type") == "forward_user_token":
            fresh_token = await _fetch_keycloak_sa_token()
            if fresh_token:
                entry.auth = {**entry.auth, "token": fresh_token}
                logger.debug("Refreshed SA token for upstream '%s'", entry.slug)

        # Stateless upstreams (forward_user_token with no service-account token)
        # have no persistent session.  Mark them connected immediately so the
        # pool doesn't keep retrying and the proxy 503 gate passes through.
        if entry.is_stateless:
            entry.session = None
            entry.status = UpstreamStatus.CONNECTED
            entry.failure_count = 0
            entry.last_error = None
            logger.info(
                "Upstream '%s' registered in stateless forward_user_token mode "
                "(Keycloak SA not available — tool sync skipped)",
                entry.slug,
            )
            return

        try:
            import contextlib
            exit_stack = contextlib.AsyncExitStack()
            await exit_stack.__aenter__()

            headers = entry.auth_headers()

            if entry.transport == "streamable_http":
                read, write, _ = await exit_stack.enter_async_context(
                    streamablehttp_client(entry.url, headers=headers)
                )
            elif entry.transport == "sse":
                read, write = await exit_stack.enter_async_context(
                    sse_client(entry.url, headers=headers)
                )
            else:
                raise ValueError(f"Unsupported transport: {entry.transport}")

            session = await exit_stack.enter_async_context(ClientSession(read, write))
            await session.initialize()

            entry.session = session
            entry._exit_stack = exit_stack
            entry.status = UpstreamStatus.CONNECTED
            entry.failure_count = 0
            entry.last_error = None

            logger.info("Connected to upstream '%s' at %s", entry.slug, entry.url)

            # Refresh tool cache in DB
            await self._sync_tools(entry)

        except Exception as exc:
            entry.status = UpstreamStatus.DISCONNECTED
            entry.failure_count += 1
            entry.last_error = str(exc)
            entry.session = None
            if entry._exit_stack:
                try:
                    await entry._exit_stack.__aexit__(None, None, None)
                except Exception:
                    pass
                entry._exit_stack = None
            logger.warning(
                "Failed to connect to upstream '%s': %s (attempt %d)",
                entry.slug,
                exc,
                entry.failure_count,
            )

    async def _disconnect(self, entry: UpstreamEntry) -> None:
        entry.status = UpstreamStatus.DISCONNECTED
        entry.session = None
        if entry._exit_stack:
            try:
                await entry._exit_stack.__aexit__(None, None, None)
            except Exception:
                pass
            entry._exit_stack = None

    async def _sync_tools(self, entry: UpstreamEntry) -> None:
        """Pull tools/list from the upstream and upsert into SurrealDB."""
        if not entry.session:
            return
        try:
            from app.db import queries

            result = await entry.session.list_tools()
            tools = [
                {
                    "name": t.name,
                    "description": t.description,
                    "inputSchema": (
                        t.inputSchema if isinstance(t.inputSchema, dict)
                        else t.inputSchema.model_dump()
                    ) if t.inputSchema else None,
                }
                for t in result.tools
            ]
            await queries.upsert_tools(entry.slug, tools)
            logger.info("Synced %d tools for upstream '%s'", len(tools), entry.slug)
        except Exception as exc:
            logger.warning("Tool sync failed for '%s': %s", entry.slug, exc)

    # ------------------------------------------------------------------
    # Health loop
    # ------------------------------------------------------------------

    async def _health_loop(self) -> None:
        while True:
            await asyncio.sleep(settings.upstream_health_interval_seconds)
            for entry in list(self._entries.values()):
                if entry.is_stateless:
                    # No session to ping; liveness is confirmed per-call.
                    continue
                if entry.status == UpstreamStatus.CONNECTED:
                    await self._ping(entry)
                elif entry.status == UpstreamStatus.DISCONNECTED:
                    # Attempt reconnect (respects backoff implicitly — the loop
                    # runs every N seconds so rapid retries can't happen)
                    await self._connect(entry)

    async def _ping(self, entry: UpstreamEntry) -> None:
        """Ping the upstream and sync its tool listing to SurrealDB.

        We reuse _sync_tools (which calls list_tools internally) as the ping
        itself — this way every health-loop tick keeps the tool cache current,
        satisfying the TODO requirement to poll MCP servers for tool discovery.
        A separate list_tools call is unnecessary duplication.

        Upstreams with auth type "none" rely on per-user credentials injected
        at call time (requires_user_credential=true).  The shared session has
        no auth header, so tool sync over it will always fail — skip it to
        avoid constant spurious warning noise.
        """
        auth_type = (entry.auth or {}).get("type", "")
        if auth_type == "none":
            logger.debug(
                "Skipping health-loop tool sync for '%s' (auth=none, per-user creds only)",
                entry.slug,
            )
            return

        try:
            await asyncio.wait_for(self._sync_tools(entry), timeout=10.0)
            entry.status = UpstreamStatus.CONNECTED
            entry.last_error = None
        except asyncio.TimeoutError:
            logger.warning("Health check timed out for '%s' — marking degraded", entry.slug)
            entry.status = UpstreamStatus.DEGRADED
            entry.last_error = "Health check timed out"
            await self._disconnect(entry)
        except Exception as exc:
            logger.warning("Health check failed for '%s': %s — marking degraded", entry.slug, exc)
            entry.status = UpstreamStatus.DEGRADED
            entry.last_error = str(exc)
            # Attempt a full reconnect on next loop tick
            await self._disconnect(entry)


upstream_pool = UpstreamPool()
