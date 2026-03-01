from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import AnyHttpUrl


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Keycloak
    keycloak_url: AnyHttpUrl
    keycloak_realm: str
    keycloak_client_id: str
    keycloak_client_secret: str | None = None
    # Claim within the JWT that contains group memberships
    keycloak_groups_claim: str = "groups"
    # Keycloak group paths that grant admin access to this gateway.
    # Any membership in this list is sufficient. Pydantic-settings parses
    # the env var as JSON: ADMIN_GROUPS='["/admins"]'
    admin_groups: list[str] = ["/admins"]

    # SurrealDB
    surreal_url: str = "ws://localhost:8000/rpc"
    surreal_user: str = "root"
    surreal_pass: str = "root"
    surreal_namespace: str = "just4mcps"
    surreal_database: str = "mcp_gateway"

    # App
    # Explicit public base URL for the gateway API, used when generating connector
    # configs for MCP clients. If your ingress strips a path prefix (e.g. /api)
    # before forwarding, set this to the full public URL including that prefix.
    gateway_public_url: str | None = None
    cors_origins: list[str] = ["http://localhost:5173"]
    upstream_health_interval_seconds: int = 30
    upstream_reconnect_max_delay_seconds: int = 300
    # Security
    superuser_groups: list[str] = ["/admins"]
    credential_encryption_key: str | None = None

    @property
    def keycloak_issuer(self) -> str:
        return f"{str(self.keycloak_url).rstrip('/')}/realms/{self.keycloak_realm}"

    @property
    def keycloak_jwks_uri(self) -> str:
        return f"{self.keycloak_issuer}/protocol/openid-connect/certs"

    @property
    def keycloak_token_uri(self) -> str:
        return f"{self.keycloak_issuer}/protocol/openid-connect/token"

    @property
    def keycloak_auth_uri(self) -> str:
        return f"{self.keycloak_issuer}/protocol/openid-connect/auth"


settings = Settings()
