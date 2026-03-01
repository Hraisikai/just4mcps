"""
Utilities for encrypting and decrypting user credentials.
"""

import logging

from cryptography.fernet import Fernet

from app.config import settings

logger = logging.getLogger(__name__)

# Module-level cache so that the ephemeral fallback key is stable within a
# single process lifetime (encrypt + decrypt will use the same key even when
# CREDENTIAL_ENCRYPTION_KEY is not configured).  In production you MUST set the
# env var so the key survives restarts.
_ephemeral_key: bytes | None = None


def get_or_generate_key() -> bytes:
    """
    Get the configured encryption key or generate an ephemeral one.

    If no key is configured, generates a temporary key (once per process) and
    logs a CRITICAL warning.  Credentials stored with the ephemeral key will be
    unreadable after a restart.
    """
    global _ephemeral_key

    if settings.credential_encryption_key:
        return settings.credential_encryption_key.encode()

    if _ephemeral_key is None:
        _ephemeral_key = Fernet.generate_key()
        logger.critical(
            "No CREDENTIAL_ENCRYPTION_KEY configured. Using an ephemeral key; "
            "credentials will NOT be readable after a restart. "
            "Set CREDENTIAL_ENCRYPTION_KEY to a stable Fernet key in production."
        )
    return _ephemeral_key


def encrypt_credential(plaintext: str) -> str:
    """
    Encrypt a plaintext credential string.

    Raises ValueError if encryption key is None and cannot be generated.
    """
    fernet = Fernet(get_or_generate_key())
    ciphertext = fernet.encrypt(plaintext.encode())
    return ciphertext.decode()


def decrypt_credential(ciphertext: str) -> str:
    """
    Decrypt an encrypted credential string.

    Raises ValueError or InvalidToken on decryption failure.
    """
    fernet = Fernet(get_or_generate_key())
    plaintext = fernet.decrypt(ciphertext.encode())
    return plaintext.decode()
