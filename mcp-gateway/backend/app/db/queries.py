"""
Named query functions. All SQL lives here — nothing raw scattered elsewhere.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from app.db.client import db


# ---------------------------------------------------------------------------
# MCP Servers
# ---------------------------------------------------------------------------


async def list_mcp_servers() -> list[dict]:
    result = await db.query("SELECT * FROM mcp_server ORDER BY name ASC")
    return result[0] if result else []


async def get_mcp_server(slug: str) -> dict | None:
    result = await db.query(
        "SELECT * FROM mcp_server WHERE slug = $slug LIMIT 1",
        {"slug": slug},
    )
    rows = result[0] if result else []
    return rows[0] if rows else None


async def create_mcp_server(data: dict) -> dict:
    result = await db.query(
        """
        CREATE mcp_server CONTENT {
            slug: $slug,
            name: $name,
            description: $description,
            upstream_url: $upstream_url,
            transport: $transport,
            upstream_auth: $upstream_auth,
            enabled: $enabled,
            requires_user_credential: $requires_user_credential
        }
        """,
        data,
    )
    return result[0][0]


async def update_mcp_server(slug: str, data: dict) -> dict | None:
    result = await db.query(
        "UPDATE mcp_server SET $data WHERE slug = $slug RETURN AFTER",
        {"slug": slug, "data": data},
    )
    rows = result[0] if result else []
    return rows[0] if rows else None


async def delete_mcp_server(slug: str) -> bool:
    # Three separate calls — avoids multi-statement result-format issues with
    # the surrealdb 1.0.x SDK and keeps each operation clearly ordered.
    await db.query("DELETE can_use WHERE mcp_slug = $slug", {"slug": slug})
    await db.query("DELETE tool WHERE mcp_slug = $slug", {"slug": slug})
    await db.query("DELETE mcp_server WHERE slug = $slug", {"slug": slug})
    return True


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


async def list_tools_for_server(slug: str) -> list[dict]:
    result = await db.query(
        "SELECT * FROM tool WHERE mcp_slug = $slug ORDER BY tool_name ASC",
        {"slug": slug},
    )
    return result[0] if result else []


async def upsert_tools(slug: str, tools: list[dict]) -> None:
    """Replace the full tool listing for a given MCP server."""
    # Delete tools no longer reported by the upstream
    incoming_names = [t["name"] for t in tools]
    await db.query(
        "DELETE tool WHERE mcp_slug = $slug AND tool_name NOT IN $names",
        {"slug": slug, "names": incoming_names},
    )
    for tool in tools:
        # Deterministic record ID so UPSERT correctly creates-or-updates.
        # UPSERT ... WHERE silently does nothing for new records in SurrealDB.
        await db.query(
            """
            UPSERT type::record("tool", string::concat($slug, "|", $name)) SET
                tool_name    = $name,
                mcp_slug     = $slug,
                description  = $description,
                input_schema = $input_schema
            """,
            {
                "slug": slug,
                "name": tool["name"],
                "description": tool.get("description"),
                "input_schema": tool.get("inputSchema"),
            },
        )


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


async def get_effective_tools(slug: str, groups: list[str]) -> list[dict]:
    """
    Return tools on `slug` that at least one of `groups` has permission to use.

    Two-step approach to avoid touching the reserved `in`/`out` relation fields:
    1. Get allowed tool names from can_use using regular columns (group_path, mcp_slug).
    2. Fetch full tool records from the tool table by name.
    """
    if not groups:
        return []
    # Step 1: which tool names are allowed for these groups on this server?
    perm_result = await db.query(
        """
        SELECT tool_name FROM can_use
        WHERE group_path IN $groups AND mcp_slug = $slug
        """,
        {"slug": slug, "groups": groups},
    )
    perm_rows = perm_result[0] if perm_result else []
    allowed_names = list({r["tool_name"] for r in perm_rows if r.get("tool_name")})
    if not allowed_names:
        return []
    # Step 2: fetch the full tool records so callers get schema/description too
    tool_result = await db.query(
        "SELECT * FROM tool WHERE mcp_slug = $slug AND tool_name IN $names ORDER BY tool_name",
        {"slug": slug, "names": allowed_names},
    )
    return tool_result[0] if tool_result else []


async def list_permissions_for_server(slug: str) -> list[dict]:
    result = await db.query(
        """
        SELECT group_path, tool_name, granted_by, granted_at
        FROM can_use
        WHERE mcp_slug = $slug
        ORDER BY group_path, tool_name
        """,
        {"slug": slug},
    )
    return result[0] if result else []


async def list_permissions_for_group(group_path: str) -> list[dict]:
    result = await db.query(
        """
        SELECT mcp_slug, tool_name, granted_by, granted_at
        FROM can_use
        WHERE group_path = $group
        ORDER BY mcp_slug, tool_name
        """,
        {"group": group_path},
    )
    return result[0] if result else []


async def grant_permission(slug: str, tool_name: str, group_path: str, granted_by: str) -> dict:
    """Grant a group access to a specific tool. Idempotent via deterministic record ID.

    Uses UPSERT with a content-derived record ID so repeated calls are safe and
    the underlying record is never duplicated. Stores group_path, mcp_slug, and
    tool_name as plain columns — the SurrealDB relation `in`/`out` fields are
    intentionally never touched.
    """
    # Single-statement UPSERT on a deterministic record ID.
    # type::record() builds the record ID inline — no LET needed, which avoids
    # multi-statement result-format ambiguity with the surrealdb 1.0.x SDK.
    result = await db.query(
        """
        UPSERT type::record("can_use", string::concat($group, "|", $slug, "|", $tool_name)) SET
            group_path = $group,
            mcp_slug   = $slug,
            tool_name  = $tool_name,
            granted_by = $granted_by,
            granted_at = time::now()
        """,
        {
            "slug": slug,
            "tool_name": tool_name,
            "group": group_path,
            "granted_by": granted_by,
        },
    )
    rows = result[0] if result else []
    return rows[0] if rows else {}


async def revoke_permission(slug: str, tool_name: str, group_path: str) -> bool:
    await db.query(
        """
        DELETE can_use
        WHERE group_path = $group AND mcp_slug = $slug AND tool_name = $tool_name
        """,
        {"slug": slug, "tool_name": tool_name, "group": group_path},
    )
    return True


async def bulk_set_permissions(
    slug: str,
    group_path: str,
    tool_names: list[str],
    granted_by: str,
) -> None:
    """
    Replace a group's permissions on a given MCP server wholesale.
    Useful for the 'edit group permissions' UX — send the full desired set.
    """
    # Revoke all current permissions for this group on this server
    await db.query(
        "DELETE can_use WHERE group_path = $group AND mcp_slug = $slug",
        {"group": group_path, "slug": slug},
    )
    for tool_name in tool_names:
        await grant_permission(slug, tool_name, group_path, granted_by)


async def list_all_groups() -> list[str]:
    """Return every distinct group that has at least one permission."""
    result = await db.query(
        "SELECT group_path FROM can_use GROUP BY group_path ORDER BY group_path"
    )
    rows = result[0] if result else []
    return [r["group_path"] for r in rows]


# ---------------------------------------------------------------------------
# User Credentials
# ---------------------------------------------------------------------------


async def get_user_credential(user_sub: str, mcp_slug: str) -> str | None:
    """Return the encrypted credential value for a user+mcp combo, or None."""
    result = await db.query(
        """
        SELECT encrypted_val FROM user_credential
        WHERE user_sub = $user_sub AND mcp_slug = $mcp_slug
        LIMIT 1
        """,
        {"user_sub": user_sub, "mcp_slug": mcp_slug},
    )
    rows = result[0] if result else []
    if rows:
        return rows[0].get("encrypted_val")
    return None


async def upsert_user_credential(user_sub: str, mcp_slug: str, encrypted_val: str) -> None:
    """Create or replace a user's credential for a given MCP.

    Clears the is_invalid flag so that a freshly-set credential is treated as valid
    until the upstream proves otherwise.
    """
    await db.query(
        """
        UPSERT type::record("user_credential", string::concat($user_sub, "|", $mcp_slug)) SET
            user_sub      = $user_sub,
            mcp_slug      = $mcp_slug,
            encrypted_val = $encrypted_val,
            is_invalid    = false,
            last_error_at = NONE,
            updated_at    = time::now()
        """,
        {"user_sub": user_sub, "mcp_slug": mcp_slug, "encrypted_val": encrypted_val},
    )


async def mark_credential_invalid(user_sub: str, mcp_slug: str) -> None:
    """Flag a stored credential as invalid (expired / revoked / rotated).

    Called by the proxy when the upstream returns 401/403 on a PAT call.
    """
    await db.query(
        """
        UPDATE user_credential
        SET is_invalid = true, last_error_at = time::now()
        WHERE user_sub = $user_sub AND mcp_slug = $mcp_slug
        """,
        {"user_sub": user_sub, "mcp_slug": mcp_slug},
    )


async def delete_user_credential(user_sub: str, mcp_slug: str) -> None:
    """Remove a user's stored credential for a given MCP."""
    await db.query(
        """
        DELETE user_credential
        WHERE user_sub = $user_sub AND mcp_slug = $mcp_slug
        """,
        {"user_sub": user_sub, "mcp_slug": mcp_slug},
    )


async def get_user_credential_status(user_sub: str, mcp_slug: str) -> dict | None:
    """Return credential metadata (without the encrypted value) for a user+mcp combo."""
    result = await db.query(
        """
        SELECT is_invalid, last_error_at, updated_at FROM user_credential
        WHERE user_sub = $user_sub AND mcp_slug = $mcp_slug
        LIMIT 1
        """,
        {"user_sub": user_sub, "mcp_slug": mcp_slug},
    )
    rows = result[0] if result else []
    return rows[0] if rows else None


async def list_user_credential_slugs(user_sub: str) -> list[str]:
    """Return list of mcp_slugs for which this user has a credential stored."""
    result = await db.query(
        """
        SELECT mcp_slug FROM user_credential
        WHERE user_sub = $user_sub
        ORDER BY mcp_slug
        """,
        {"user_sub": user_sub},
    )
    rows = result[0] if result else []
    return [r["mcp_slug"] for r in rows]
