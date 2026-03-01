"""
FastAPI dependency injection for authentication and authorization.
"""

from dataclasses import dataclass
from typing import Annotated

import logging

from fastapi import Depends, HTTPException, Request, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth.keycloak import decode_token, extract_groups, _resource_metadata_url
from app.config import settings

logger = logging.getLogger(__name__)

# auto_error=False so we can return a proper RFC 9728 WWW-Authenticate
# header with resource_metadata instead of FastAPI's generic 403.
_bearer = HTTPBearer(auto_error=False)


@dataclass
class CurrentUser:
    subject: str
    email: str | None
    groups: list[str]
    claims: dict
    raw_token: str  # the original JWT — forwarded to same-OIDC upstreams

    @property
    def is_admin(self) -> bool:
        return any(g in self.groups for g in settings.admin_groups)


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Security(_bearer)],
    request: Request,
) -> CurrentUser:
    if credentials is None:
        auth_header = request.headers.get("authorization", "<missing>")
        logger.warning(
            "No bearer credentials extracted — raw Authorization header: %s",
            auth_header[:80] if auth_header else "<missing>",
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={
                "WWW-Authenticate": (
                    f'Bearer resource_metadata="{_resource_metadata_url()}"'
                ),
            },
        )
    try:
        claims = await decode_token(credentials.credentials)
    except HTTPException:
        logger.warning(
            "Token validation failed — token prefix: %s...",
            credentials.credentials[:40],
        )
        raise
    return CurrentUser(
        subject=claims.get("sub", ""),
        email=claims.get("email"),
        groups=extract_groups(claims),
        claims=claims,
        raw_token=credentials.credentials,
    )


async def require_admin(
    user: Annotated[CurrentUser, Depends(get_current_user)],
) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Requires membership in one of: {settings.admin_groups}",
        )
    return user


# Convenient type aliases for route signatures
CurrentUserDep = Annotated[CurrentUser, Depends(get_current_user)]
AdminUserDep = Annotated[CurrentUser, Depends(require_admin)]
