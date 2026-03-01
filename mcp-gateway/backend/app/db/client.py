"""
SurrealDB async client wrapper with schema initialization.

Includes automatic reconnection when the WebSocket drops (e.g. keepalive
ping timeout) so callers never see a raw ConnectionClosedError.
"""

import asyncio
import logging

from surrealdb import AsyncSurreal

from app.config import settings

logger = logging.getLogger(__name__)

# Max retries on connection-closed errors before giving up
_MAX_RECONNECT_RETRIES = 2

# DDL for our schema — idempotent (IF NOT EXISTS throughout)
_SCHEMA_DDL = """
-- MCP Server registry
DEFINE TABLE IF NOT EXISTS mcp_server SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS slug         ON mcp_server TYPE string ASSERT $value != NONE;
DEFINE FIELD IF NOT EXISTS name         ON mcp_server TYPE string ASSERT $value != NONE;
DEFINE FIELD IF NOT EXISTS description  ON mcp_server TYPE option<string>;
DEFINE FIELD IF NOT EXISTS upstream_url ON mcp_server TYPE string ASSERT $value != NONE;
DEFINE FIELD IF NOT EXISTS transport    ON mcp_server TYPE string
    ASSERT $value IN ["streamable_http", "sse", "stdio"];
DEFINE FIELD IF NOT EXISTS upstream_auth        ON mcp_server TYPE option<object>;
-- Sub-fields required by SurrealDB schemafull mode (used by all auth types)
DEFINE FIELD IF NOT EXISTS upstream_auth.type   ON mcp_server TYPE option<string>;
DEFINE FIELD IF NOT EXISTS upstream_auth.token  ON mcp_server TYPE option<string>;
DEFINE FIELD IF NOT EXISTS upstream_auth.header ON mcp_server TYPE option<string>;
DEFINE FIELD IF NOT EXISTS upstream_auth.value  ON mcp_server TYPE option<string>;
DEFINE FIELD IF NOT EXISTS enabled      ON mcp_server TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS requires_user_credential ON mcp_server TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS credential_url ON mcp_server TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at   ON mcp_server TYPE datetime VALUE $before OR time::now();
DEFINE FIELD IF NOT EXISTS updated_at   ON mcp_server TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS mcp_server_slug ON mcp_server FIELDS slug UNIQUE;

-- Tools discovered from upstream MCP servers
DEFINE TABLE IF NOT EXISTS tool SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS tool_name    ON tool TYPE string ASSERT $value != NONE;
DEFINE FIELD IF NOT EXISTS mcp_slug     ON tool TYPE string ASSERT $value != NONE;
DEFINE FIELD IF NOT EXISTS description  ON tool TYPE option<string>;
-- OVERWRITE (not IF NOT EXISTS) so FLEXIBLE is applied even when the field
-- already exists without it — SurrealDB requires FLEXIBLE to allow arbitrary
-- nested sub-fields (e.g. JSON Schema structures) in a SCHEMAFULL table.
DEFINE FIELD OVERWRITE input_schema ON tool TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS refreshed_at ON tool TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS tool_unique ON tool FIELDS mcp_slug, tool_name UNIQUE;

-- Group → tool permissions (plain lookup table, NOT a graph relation).
-- We intentionally avoid SurrealDB's in/out relation fields because `in` is a
-- reserved keyword that cannot be escaped in query expressions. Instead, we
-- store group_path, mcp_slug, and tool_name as regular columns, and generate
-- a deterministic record ID from their concatenation for idempotent upserts.
--
-- TYPE NORMAL is required to prevent SurrealDB from treating this as a graph
-- relation. Using OVERWRITE (not IF NOT EXISTS) so the table type is corrected
-- even if a prior deploy created it as a RELATION type.
DEFINE TABLE OVERWRITE can_use SCHEMAFULL TYPE NORMAL;
DEFINE FIELD OVERWRITE group_path ON can_use TYPE string ASSERT $value != NONE;
DEFINE FIELD OVERWRITE mcp_slug   ON can_use TYPE string ASSERT $value != NONE;
DEFINE FIELD OVERWRITE tool_name  ON can_use TYPE string ASSERT $value != NONE;
DEFINE FIELD OVERWRITE granted_by ON can_use TYPE string ASSERT $value != NONE;
DEFINE FIELD OVERWRITE granted_at ON can_use TYPE datetime VALUE $before OR time::now();
DEFINE INDEX OVERWRITE can_use_unique ON can_use FIELDS group_path, mcp_slug, tool_name UNIQUE;

-- Per-user credentials (e.g. GitLab PATs)
DEFINE TABLE IF NOT EXISTS user_credential SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS user_sub        ON user_credential TYPE string  ASSERT $value != NONE;
DEFINE FIELD IF NOT EXISTS mcp_slug        ON user_credential TYPE string  ASSERT $value != NONE;
DEFINE FIELD IF NOT EXISTS encrypted_val   ON user_credential TYPE string  ASSERT $value != NONE;
-- Set true when the upstream returns 401/403; cleared on credential update.
DEFINE FIELD IF NOT EXISTS is_invalid      ON user_credential TYPE bool    DEFAULT false;
DEFINE FIELD IF NOT EXISTS last_error_at   ON user_credential TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at      ON user_credential TYPE datetime VALUE $before OR time::now();
DEFINE FIELD IF NOT EXISTS updated_at      ON user_credential TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS ucred_unique    ON user_credential FIELDS user_sub, mcp_slug UNIQUE;
"""


class _DB:
    def __init__(self):
        self._client: AsyncSurreal | None = None
        self._lock = asyncio.Lock()

    @property
    def client(self) -> AsyncSurreal:
        if self._client is None:
            raise RuntimeError("DB not connected — call db.connect() first")
        return self._client

    async def connect(self) -> None:
        self._client = AsyncSurreal(settings.surreal_url)
        await self._client.connect()
        await self._client.signin({"username": settings.surreal_user, "password": settings.surreal_pass})
        await self._client.use(settings.surreal_namespace, settings.surreal_database)
        logger.info(
            "Connected to SurrealDB at %s (ns=%s db=%s)",
            settings.surreal_url,
            settings.surreal_namespace,
            settings.surreal_database,
        )

    async def _reconnect(self) -> None:
        """Drop the dead connection and establish a fresh one."""
        async with self._lock:
            logger.warning("Reconnecting to SurrealDB…")
            if self._client:
                try:
                    await self._client.close()
                except Exception:
                    pass
            self._client = AsyncSurreal(settings.surreal_url)
            await self._client.connect()
            await self._client.signin({"username": settings.surreal_user, "password": settings.surreal_pass})
            await self._client.use(settings.surreal_namespace, settings.surreal_database)
            logger.info("Reconnected to SurrealDB successfully")

    async def ensure_schema(self) -> None:
        await self._client.query(_SCHEMA_DDL)
        logger.info("SurrealDB schema verified")

    async def close(self) -> None:
        if self._client:
            await self._client.close()
            self._client = None

    def _is_connection_error(self, exc: Exception) -> bool:
        """Check if the exception indicates a dead WebSocket connection."""
        exc_type = type(exc).__name__
        exc_str = str(exc).lower()
        return (
            "ConnectionClosed" in exc_type
            or "ConnectionClosedError" in exc_type
            or "keepalive ping timeout" in exc_str
            or "close frame" in exc_str
            or "websocket" in exc_str.lower()
            or "connection" in exc_type.lower() and "closed" in exc_str
        )

    async def query(self, sql: str, vars: dict | None = None):
        last_exc: Exception | None = None
        for attempt in range(_MAX_RECONNECT_RETRIES + 1):
            try:
                raw = await self.client.query(sql, vars or {})
                return self._normalize(raw)
            except Exception as exc:
                if self._is_connection_error(exc):
                    last_exc = exc
                    logger.warning(
                        "SurrealDB connection error (attempt %d/%d): %s",
                        attempt + 1, _MAX_RECONNECT_RETRIES + 1, exc,
                    )
                    await self._reconnect()
                    continue
                raise
        # All retries exhausted
        raise last_exc  # type: ignore[misc]

    @staticmethod
    def _normalize(raw):
        """Normalize surrealdb SDK return format to [[records], ...]."""
        # surrealdb Python SDK 1.0.x changed the return format:
        #   Single statement → [record, record, ...]          (flat list of dicts)
        #   Multi-statement  → [result_per_stmt, ...]         (list of lists)
        # All callers use `result[0]` to get the records for the first statement,
        # which worked with the old [[records]] format but breaks with [record, ...].
        # Normalize to [[records], ...] so existing callers are unaffected.
        if not isinstance(raw, list) or not raw:
            return [[]]
        first = raw[0]
        if isinstance(first, dict):
            # Flat list of record dicts — single-statement result; wrap it.
            return [raw]
        # Otherwise it's already [[...], ...] multi-statement format (or [[], ...]).
        return raw


db = _DB()
