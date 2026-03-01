"""
Auth utility endpoints — no JWT required (called before we have one).

POST /auth/exchange
    Browser-side PKCE code → tokens proxy.

POST /auth/token
    Standards-compliant OAuth2 token proxy for native MCP clients.

GET /.well-known/oauth-protected-resource
    RFC 9728 Protected Resource Metadata — tells MCP clients where to find
    the authorization server.

GET /.well-known/oauth-authorization-server
    RFC 8414 Authorization Server Metadata — advertises endpoints with the
    token_endpoint pointing at our proxy (so client_secret is injected
    server-side for confidential Keycloak clients).
"""

import logging

import httpx
from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["auth"])

# ---------------------------------------------------------------------------
# RFC 9728 — OAuth 2.0 Protected Resource Metadata
# ---------------------------------------------------------------------------

_OAUTH_SCOPES = ["openid", "profile", settings.keycloak_groups_claim]


def _gateway_base_url() -> str:
    """Return the public base URL for this gateway (no trailing slash)."""
    return (settings.gateway_public_url or "").rstrip("/")


@router.get("/.well-known/oauth-protected-resource")
@router.get("/.well-known/oauth-protected-resource/{path:path}")
async def protected_resource_metadata(request: Request):
    """
    RFC 9728 Protected Resource Metadata.

    Tells MCP clients which authorization server to use. We point
    ``authorization_servers`` at our own gateway so clients fetch *our*
    AS metadata (which lists the token-proxy endpoint) rather than
    Keycloak's (whose token_endpoint requires a client_secret).
    """
    base = _gateway_base_url()
    return JSONResponse(
        content={
            "resource": base,
            "authorization_servers": [base],
            "scopes_supported": _OAUTH_SCOPES,
            "bearer_methods_supported": ["header"],
        },
        headers={"Access-Control-Allow-Origin": "*"},
    )


# ---------------------------------------------------------------------------
# RFC 8414 — OAuth 2.0 Authorization Server Metadata
# ---------------------------------------------------------------------------


@router.get("/.well-known/oauth-authorization-server")
@router.get("/.well-known/oauth-authorization-server/{path:path}")
async def authorization_server_metadata(request: Request):
    """
    RFC 8414 Authorization Server Metadata.

    Advertises endpoints so MCP clients can perform the full PKCE flow.
    ``token_endpoint`` points at our own proxy (``/auth/token``) which
    injects the client_secret before forwarding to Keycloak.
    ``authorization_endpoint`` points directly at Keycloak.
    """
    base = _gateway_base_url()
    return JSONResponse(
        content={
            "issuer": base,
            "authorization_endpoint": settings.keycloak_auth_uri,
            "token_endpoint": f"{base}/auth/token",
            "jwks_uri": settings.keycloak_jwks_uri,
            "scopes_supported": _OAUTH_SCOPES,
            "response_types_supported": ["code"],
            "grant_types_supported": [
                "authorization_code",
                "refresh_token",
            ],
            "token_endpoint_auth_methods_supported": ["none"],
            "code_challenge_methods_supported": ["S256"],
        },
        headers={"Access-Control-Allow-Origin": "*"},
    )


# ---------------------------------------------------------------------------
# Token exchange helpers
# ---------------------------------------------------------------------------


class TokenExchangeRequest(BaseModel):
    code: str
    redirect_uri: str
    code_verifier: str


class TokenExchangeResponse(BaseModel):
    access_token: str
    refresh_token: str
    id_token: str | None = None
    expires_in: int
    token_type: str = "Bearer"


class RefreshTokenRequest(BaseModel):
    refresh_token: str


@router.post("/auth/exchange", response_model=TokenExchangeResponse)
async def exchange_code(body: TokenExchangeRequest) -> TokenExchangeResponse:
    """
    Exchange an authorization code for tokens.

    Keycloak requires the client secret on the token endpoint even when PKCE
    is used (confidential client).  The frontend POSTs the auth code and PKCE
    verifier here; we add the client secret and forward to Keycloak.
    """
    data: dict[str, str] = {
        "grant_type": "authorization_code",
        "client_id": settings.keycloak_client_id,
        "redirect_uri": body.redirect_uri,
        "code": body.code,
        "code_verifier": body.code_verifier,
    }

    if settings.keycloak_client_secret:
        data["client_secret"] = settings.keycloak_client_secret

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            settings.keycloak_token_uri,
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=15,
        )

    if not resp.is_success:
        body_text = resp.text
        logger.warning(
            "Keycloak token exchange failed: status=%s body=%s",
            resp.status_code,
            body_text[:500],
        )
        try:
            err = resp.json()
            detail = err.get("error_description") or err.get("error") or body_text
        except Exception:
            detail = body_text or f"Keycloak returned {resp.status_code}"

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
        )

    payload = resp.json()
    return TokenExchangeResponse(
        access_token=payload["access_token"],
        refresh_token=payload["refresh_token"],
        id_token=payload.get("id_token"),
        expires_in=payload["expires_in"],
        token_type=payload.get("token_type", "Bearer"),
    )


@router.post("/auth/token")
async def token_proxy(request: Request) -> Response:
    """
    Standards-compliant OAuth2 token endpoint proxy.

    Claude Desktop (and other native MCP clients) perform the PKCE token
    exchange by POSTing application/x-www-form-urlencoded directly to the
    tokenUrl — they have no way to supply a client_secret.  Since
    the gateway's Keycloak client is confidential so we inject the secret
    here server-side before forwarding to Keycloak.

    Accepts any grant_type (authorization_code, refresh_token, etc.) and
    proxies it transparently so clients don't need gateway-specific logic.
    """
    body = await request.body()

    # Parse the form-encoded body and inject the client secret
    from urllib.parse import parse_qs, urlencode
    params = {k: v[0] for k, v in parse_qs(body.decode()).items()}

    params.setdefault("client_id", settings.keycloak_client_id)
    if settings.keycloak_client_secret:
        params["client_secret"] = settings.keycloak_client_secret

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            settings.keycloak_token_uri,
            data=urlencode(params),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=15,
        )

    if not resp.is_success:
        logger.warning(
            "Token proxy: Keycloak returned %s — grant_type=%s error=%s",
            resp.status_code,
            params.get("grant_type"),
            resp.text[:200],
        )

    # Proxy the response transparently — preserve status code and body
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/json"),
    )


@router.post("/auth/refresh", response_model=TokenExchangeResponse)
async def refresh_token(body: RefreshTokenRequest) -> TokenExchangeResponse:
    """
    Refresh an expired access token using a refresh token.

    The frontend POSTs the refresh token here; we add the client credentials
    and forward to Keycloak.
    """
    data: dict[str, str] = {
        "grant_type": "refresh_token",
        "client_id": settings.keycloak_client_id,
        "refresh_token": body.refresh_token,
    }

    if settings.keycloak_client_secret:
        data["client_secret"] = settings.keycloak_client_secret

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            settings.keycloak_token_uri,
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=15,
        )

    if not resp.is_success:
        body_text = resp.text
        logger.warning(
            "Keycloak token refresh failed: status=%s body=%s",
            resp.status_code,
            body_text[:500],
        )
        try:
            err = resp.json()
            detail = err.get("error_description") or err.get("error") or body_text
        except Exception:
            detail = body_text or f"Keycloak returned {resp.status_code}"

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
        )

    payload = resp.json()
    return TokenExchangeResponse(
        access_token=payload["access_token"],
        refresh_token=payload["refresh_token"],
        id_token=payload.get("id_token"),
        expires_in=payload["expires_in"],
        token_type=payload.get("token_type", "Bearer"),
    )
