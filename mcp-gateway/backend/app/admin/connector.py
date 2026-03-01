"""
Connector config generation.

Returns ready-to-paste config for Claude Desktop / Claude Code / any MCP client.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.auth.dependencies import AdminUserDep
from app.config import settings
from app.db import queries

router = APIRouter(prefix="/connector", tags=["admin/connector"])


class ConnectorConfig(BaseModel):
    """The config block to paste into an MCP client."""

    # Claude Code / claude_desktop_config.json format
    claude: dict
    # Generic HTTP format for other clients
    generic: dict


@router.get("/{slug}")
async def get_connector_config(slug: str, request: Request, user: AdminUserDep):
    server = await queries.get_mcp_server(slug)
    if not server:
        raise HTTPException(status_code=404, detail=f"MCP server '{slug}' not found")

    # Use the explicitly configured public URL if set (required when a reverse
    # proxy strips a path prefix before forwarding — e.g. Traefik's stripPrefix
    # drops /api, so request.base_url would produce the wrong MCP endpoint URL).
    # Falls back to the request base URL for local/dev usage.
    base_url = (settings.gateway_public_url or str(request.base_url)).rstrip("/")

    mcp_url = f"{base_url}/{slug}/mcp"

    # Point tokenUrl at the gateway's own /auth/token proxy rather than
    # Keycloak directly.  The gateway's Keycloak client is confidential — Keycloak
    # requires client_secret on the token endpoint even with PKCE.  Native
    # clients (Claude Desktop, etc.) can't supply the secret, so the proxy
    # injects it server-side and forwards to Keycloak transparently.
    token_proxy_url = f"{base_url}/auth/token"

    claude_config = {
        "mcpServers": {
            slug: {
                "type": "http",
                "url": mcp_url,
                "oauth2": {
                    "clientId": settings.keycloak_client_id,
                    "authorizationUrl": settings.keycloak_auth_uri,
                    "tokenUrl": token_proxy_url,
                    "scopes": ["openid", "profile", settings.keycloak_groups_claim],
                },
            }
        }
    }

    generic_config = {
        "name": server["name"],
        "slug": slug,
        "url": mcp_url,
        "transport": "streamable_http",
        "auth": {
            "type": "oauth2",
            "client_id": settings.keycloak_client_id,
            "authorization_url": settings.keycloak_auth_uri,
            "token_url": token_proxy_url,
            "scopes": ["openid", "profile", settings.keycloak_groups_claim],
        },
    }

    return ConnectorConfig(claude=claude_config, generic=generic_config)
