"""
User credential management routes.

Allows users to securely store credentials for MCP servers that require them.
Write-only for security (decryption is not exposed).
"""

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.auth.dependencies import CurrentUserDep
from app.db import queries
from app.security.credentials import encrypt_credential

router = APIRouter(prefix="/user/credentials", tags=["credentials"])


class SetCredentialRequest(BaseModel):
    credential: str


@router.get("")
async def list_credentials(user: CurrentUserDep) -> dict:
    """List MCP slugs for which the current user has a stored credential."""
    slugs = await queries.list_user_credential_slugs(user.subject)
    return {"slugs": slugs}


@router.get("/{slug}")
async def get_credential_status(slug: str, user: CurrentUserDep) -> dict:
    """
    Return the validity status of the user's stored credential for an MCP server.

    Never returns the credential itself — only metadata useful for the UI.
    Response shape: { exists: bool, is_invalid: bool, last_error_at: str | null, updated_at: str | null }
    """
    row = await queries.get_user_credential_status(user.subject, slug)
    if row is None:
        return {"exists": False, "is_invalid": False, "last_error_at": None, "updated_at": None}
    return {
        "exists": True,
        "is_invalid": row.get("is_invalid", False),
        "last_error_at": row.get("last_error_at"),
        "updated_at": row.get("updated_at"),
    }


@router.put("/{slug}")
async def set_credential(slug: str, body: SetCredentialRequest, user: CurrentUserDep) -> dict:
    """
    Create or update a credential for an MCP server.

    Returns 404 if the MCP slug doesn't exist.
    """
    mcp_server = await queries.get_mcp_server(slug)
    if not mcp_server:
        raise HTTPException(status_code=404, detail=f"MCP server '{slug}' not found")

    encrypted = encrypt_credential(body.credential)
    await queries.upsert_user_credential(user.subject, slug, encrypted)

    return {"slug": slug, "status": "ok"}


@router.delete("/{slug}")
async def delete_credential(slug: str, user: CurrentUserDep) -> dict:
    """Remove a credential for an MCP server."""
    mcp_server = await queries.get_mcp_server(slug)
    if not mcp_server:
        raise HTTPException(status_code=404, detail=f"MCP server '{slug}' not found")

    await queries.delete_user_credential(user.subject, slug)
    return {"slug": slug, "status": "deleted"}
