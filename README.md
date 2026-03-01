# Just4MCPs

An authenticated MCP (Model Context Protocol) gateway with role-based access control. Just4MCPs sits between your MCP clients (Claude Desktop, etc.) and your upstream MCP servers, providing centralized authentication via any OIDC-compliant identity provider and fine-grained tool-level permissions backed by SurrealDB.

## Architecture

```
MCP Client (Claude Desktop, etc.)
  → Ingress (JWT validation via Keycloak JWKS)
    → FastAPI MCP Proxy (role extraction + tool ACL from SurrealDB)
      → Upstream MCP Server A
      → Upstream MCP Server B
      → ...
```

## Features

- **OAuth2 + PKCE Authentication** — works with any OIDC provider (Keycloak, Auth0, Okta, Azure AD, etc.) using a confidential client (secret stays server-side)
- **RFC 9728 / RFC 8414 OAuth Discovery** — MCP clients can auto-discover the authorization server
- **Role-Based Access Control** — per-group, per-tool permissions stored in SurrealDB
- **Per-User Credentials** — encrypted credential storage for upstream MCP servers that need user-specific tokens
- **Admin Dashboard** — web UI for managing MCP server registrations, tool permissions, and group access
- **MCP Protocol Proxy** — transparent SSE/Streamable HTTP proxying to upstream servers
- **Hot-Reloadable Config** — upstream servers can be added/removed at runtime through the admin UI

## Prerequisites

- **An OIDC identity provider** (Keycloak, Auth0, Okta, Azure AD, etc.) — for authentication
- **Docker & Docker Compose** — for local development
- **Kubernetes cluster** (k3s, k8s, etc.) — for production deployment
- **A container registry** — to host your built images

## Quick Start: Docker Compose

This is the fastest way to get a local development environment running.

### 1. Clone and configure

```bash
git clone <repo-url>
cd just4mcps/mcp-gateway
cp backend/.env.example backend/.env
```

Edit `backend/.env` with your Keycloak details:

```env
KEYCLOAK_URL=https://your-keycloak.example.com
KEYCLOAK_REALM=your-realm
KEYCLOAK_CLIENT_ID=mcp-gateway
KEYCLOAK_CLIENT_SECRET=your-client-secret
```

### 2. Update the frontend Keycloak config

In `compose.yml`, update the frontend environment variables to match your Keycloak instance:

```yaml
environment:
  - VITE_KEYCLOAK_URL=https://your-keycloak.example.com
  - VITE_KEYCLOAK_REALM=your-realm
  - VITE_KEYCLOAK_CLIENT_ID=mcp-gateway
```

### 3. Start the stack

```bash
docker compose up --build
```

This starts three services:

| Service | Port | Description |
|---------|------|-------------|
| gateway | 8000 | FastAPI backend |
| frontend | 5173 | React dev server (Vite) |
| surrealdb | 8001 | SurrealDB database |

### 4. Open the dashboard

Navigate to `http://localhost:5173` and log in with your Keycloak credentials. From the admin dashboard you can register upstream MCP servers and configure tool permissions.

## Deployment: Kubernetes

### 1. Create the namespace

```bash
kubectl apply -f k8s/namespace/
```

### 2. Create secrets

Copy the example secret templates and fill in your values:

```bash
cp k8s/proxy/secrets.example.yaml k8s/proxy/secrets.yaml
cp k8s/surrealdb/secrets.example.yaml k8s/surrealdb/secrets.yaml
```

Edit both files with your actual credentials. To generate an encryption key:

```bash
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Apply the secrets:

```bash
kubectl apply -f k8s/surrealdb/secrets.yaml
kubectl apply -f k8s/proxy/secrets.yaml
```

### 3. Deploy SurrealDB

```bash
kubectl apply -f k8s/surrealdb/
kubectl rollout status deployment/surrealdb -n mcp-platform --timeout=120s
```

> **Note:** The PVC in `k8s/surrealdb/pvc.yaml` has no `storageClassName` set. Uncomment and set it to match your cluster's storage class (e.g. `standard`, `longhorn`, `local-path`).

### 4. Build and push container images

Build the backend and frontend images and push them to your registry:

```bash
# Backend
docker build -t your-registry.example.com/just4mcps/proxy:latest mcp-gateway/backend/
docker push your-registry.example.com/just4mcps/proxy:latest

# Frontend
docker build --target prod -t your-registry.example.com/just4mcps/frontend:latest mcp-gateway/frontend/
docker push your-registry.example.com/just4mcps/frontend:latest
```

### 5. Update manifests with your values

Before applying, edit these files to match your environment:

- `k8s/proxy/deployment.yaml` — image registry, Keycloak URL/realm/client, admin groups, gateway URL, CORS origins
- `k8s/proxy/ingressroute.yaml` — domain name, Keycloak JWKS URL, TLS cert resolver
- `k8s/mcp-gateway/frontend/deployment.yaml` — image registry, Keycloak URL/realm/client

### 6. Deploy the proxy and frontend

```bash
kubectl apply -f k8s/proxy/
kubectl rollout status deployment/mcp-proxy -n mcp-platform --timeout=120s

kubectl apply -f k8s/mcp-gateway/frontend/
kubectl rollout status deployment/mcp-frontend -n mcp-platform --timeout=120s
```

### 7. Configure ingress

The included `k8s/proxy/ingressroute.yaml` is a Traefik IngressRoute. If you use a different ingress controller (nginx, Istio, etc.), adapt the routing rules accordingly. The key routes are:

| Path | JWT Required | Purpose |
|------|-------------|---------|
| `/.well-known/oauth-*` | No | MCP OAuth discovery (RFC 9728) |
| `/api/auth/*` | No | Token exchange proxy |
| `/api/{slug}/mcp` | App-validated | MCP protocol endpoints |
| `/api/*` | Yes | Admin API |
| `/*` | No | Frontend SPA |

## Adding Upstream MCP Servers

Once deployed, upstream MCP servers are managed entirely through the admin dashboard — no manifest changes required.

1. Log in to the dashboard with an account that belongs to one of the configured admin groups.
2. Navigate to **MCP Servers** and click **Register Server**.
3. Provide the server's name, slug (URL-safe identifier), and upstream URL.
4. The gateway will connect and discover available tools automatically.
5. Go to **Groups** to assign tool-level permissions to your Keycloak groups.

MCP clients connect to `https://your-gateway.example.com/api/{slug}/mcp` and authenticate via OAuth2 PKCE. The gateway handles credential injection and tool-level access control transparently.

## Configuration Reference

All configuration is done via environment variables. The backend uses [pydantic-settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/) — set them in your `.env` file or directly in your deployment manifests.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KEYCLOAK_URL` | Yes | — | Base URL of your OIDC provider (e.g. `https://auth.example.com`) |
| `KEYCLOAK_REALM` | Yes | — | Realm or tenant path segment (Keycloak: realm name; others: see note below) |
| `KEYCLOAK_CLIENT_ID` | Yes | — | OAuth2 client ID |
| `KEYCLOAK_CLIENT_SECRET` | No | — | Client secret (for confidential clients) |
| `KEYCLOAK_GROUPS_CLAIM` | No | `groups` | JWT claim containing group/role memberships (works with any provider) |
| `ADMIN_GROUPS` | No | `["/admins"]` | JSON list of group paths with admin access |
| `SURREAL_URL` | No | `ws://localhost:8000/rpc` | SurrealDB WebSocket URL |
| `SURREAL_USER` | No | `root` | SurrealDB username |
| `SURREAL_PASS` | No | `root` | SurrealDB password |
| `SURREAL_NAMESPACE` | No | `just4mcps` | SurrealDB namespace |
| `SURREAL_DATABASE` | No | `mcp_gateway` | SurrealDB database name |
| `GATEWAY_PUBLIC_URL` | No | — | Public base URL for the API (including /api prefix if applicable) |
| `CORS_ORIGINS` | No | `["http://localhost:5173"]` | JSON list of allowed CORS origins |
| `CREDENTIAL_ENCRYPTION_KEY` | No | — | Fernet key for encrypting per-user credentials |

> **Note on OIDC URL structure:** The gateway constructs OIDC endpoints as `{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}/protocol/openid-connect/*`, which matches Keycloak's URL pattern. For other providers, set `KEYCLOAK_URL` and `KEYCLOAK_REALM` so that the resulting URL resolves correctly, or fork the `keycloak_issuer` property in `config.py` to match your provider's discovery endpoint structure.

### Frontend environment variables

These are injected at container start via `docker-entrypoint.sh` into `window.__env__`:

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:8000` | Backend API base URL |
| `VITE_KEYCLOAK_URL` | — | OIDC provider base URL |
| `VITE_KEYCLOAK_REALM` | — | Realm / tenant path segment |
| `VITE_KEYCLOAK_CLIENT_ID` | — | OAuth2 client ID |

## Identity Provider Setup

Just4MCPs works with any OIDC-compliant identity provider. The core requirements are:

1. **A confidential OAuth2 client** — with Authorization Code + PKCE grant enabled
2. **A group/role claim in the JWT** — the gateway reads group memberships from a configurable JWT claim (default: `groups`) to enforce RBAC

Set your redirect URI to `https://your-gateway.example.com/*` and your post-logout redirect to `https://your-gateway.example.com`.

### The group claim

This is the key piece. The gateway needs a claim in the access token (or ID token) that contains an array of group or role names. The claim name is configurable via `KEYCLOAK_GROUPS_CLAIM` (it works with any provider despite the name). Your `ADMIN_GROUPS` list must match the values your provider puts in that claim.

For example, if your provider emits `"groups": ["/admins", "/developers"]`, then set `ADMIN_GROUPS='["/admins"]'` to grant those users admin access.

### Provider-specific guidance

**Keycloak**: Create a confidential client, then add a **Group Membership** mapper to your client scope with Token Claim Name set to `groups`. Create groups (e.g. `/admins`) and assign users.

**Auth0**: Create a Regular Web Application. Use an Auth0 Action (Login flow) to add group/role memberships to the access token under a custom claim like `https://your-app/groups`. Set `KEYCLOAK_GROUPS_CLAIM` to match that claim name.

**Okta**: Create a Web Application with Authorization Code + PKCE. Add a Groups claim to your authorization server (Security → API → default → Claims) filtering by your desired groups. The claim name should match `KEYCLOAK_GROUPS_CLAIM`.

**Azure AD / Entra ID**: Register an application, enable ID tokens, and configure **Token configuration** → **Add groups claim**. Azure emits group object IDs by default — you may want to configure it to emit group names instead, or map IDs to names in your `ADMIN_GROUPS` config.

## Development

The Docker Compose setup includes hot-reload for both backend and frontend:

```bash
cd mcp-gateway
docker compose up --build --watch
```

- Backend changes in `backend/app/` trigger automatic restart.
- Frontend changes are picked up instantly by Vite's dev server.

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE) for details.
