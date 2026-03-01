"""
Keycloak JWT validation with cached JWKS fetching.

We cache the JWKS for 5 minutes to avoid hammering Keycloak on every request.
On a validation failure due to unknown kid, we force-refresh the cache once
before giving up — handles key rotations cleanly.
"""

import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
from authlib.jose import JsonWebKey, JsonWebToken
from authlib.jose.errors import JoseError
from fastapi import HTTPException, status

from app.config import settings

logger = logging.getLogger(__name__)


def _resource_metadata_url() -> str:
    """Return the RFC 9728 Protected Resource Metadata URL for this gateway."""
    base = (settings.gateway_public_url or "").rstrip("/")
    return f"{base}/.well-known/oauth-protected-resource"

_JWKS_TTL = 300  # seconds


@dataclass
class _JwksCache:
    keys: dict = field(default_factory=dict)
    fetched_at: float = 0.0

    def is_stale(self) -> bool:
        return (time.monotonic() - self.fetched_at) > _JWKS_TTL

    def update(self, keys: dict) -> None:
        self.keys = keys
        self.fetched_at = time.monotonic()


_cache = _JwksCache()
_jwt = JsonWebToken(["RS256", "RS384", "RS512"])


async def _fetch_jwks(force: bool = False) -> dict:
    if not force and not _cache.is_stale():
        return _cache.keys

    async with httpx.AsyncClient() as client:
        resp = await client.get(settings.keycloak_jwks_uri, timeout=10)
        resp.raise_for_status()
        jwks = resp.json()

    _cache.update(jwks)
    logger.debug("JWKS refreshed from Keycloak")
    return jwks


async def decode_token(token: str) -> dict[str, Any]:
    """
    Validate a Keycloak JWT and return the decoded claims.
    Raises HTTP 401 on any validation failure.
    """
    try:
        jwks = await _fetch_jwks()
        key_set = JsonWebKey.import_key_set(jwks)
        claims = _jwt.decode(token, key_set)
        claims.validate()
        return dict(claims)
    except JoseError as exc:
        # Could be a stale JWKS (key rotation) — try once more
        logger.warning("JWT validation failed (%s), refreshing JWKS", exc)
        try:
            jwks = await _fetch_jwks(force=True)
            key_set = JsonWebKey.import_key_set(jwks)
            claims = _jwt.decode(token, key_set)
            claims.validate()
            return dict(claims)
        except JoseError as exc2:
            logger.error("JWT validation failed after JWKS refresh: %s", exc2)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired token",
                headers={
                    "WWW-Authenticate": (
                        f'Bearer resource_metadata="{_resource_metadata_url()}"'
                    ),
                },
            ) from exc2


def extract_groups(claims: dict[str, Any]) -> list[str]:
    """
    Pull group memberships from the configured claim and normalize to
    leading-slash path format (e.g. "/developers").

    Keycloak can return groups with or without a leading "/" depending on
    whether the Groups scope mapper has "Full group path" enabled.  We always
    normalize to the slash-prefixed form so the rest of the codebase has a
    single canonical representation matching admin_groups config and DB records.

    Returns an empty list if the claim is absent.
    """
    raw = claims.get(settings.keycloak_groups_claim, [])
    if isinstance(raw, str):
        # Some Keycloak configs return a space-separated string
        raw = raw.split()
    if not isinstance(raw, list):
        return []

    def _normalize(g: str) -> str:
        g = str(g).strip()
        return g if g.startswith("/") else f"/{g}"

    return [_normalize(g) for g in raw if g]
