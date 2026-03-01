const TOKEN_KEY = "mcp_gateway_token"

// In production the entrypoint script writes window.__env__ at container start,
// allowing VITE_API_URL to be injected without a rebuild.
const API_BASE_URL =
  (window as unknown as { __env__?: { VITE_API_URL?: string } }).__env__
    ?.VITE_API_URL ||
  import.meta.env.VITE_API_URL ||
  "http://localhost:8000"

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

// ─── 401 refresh callback ───────────────────────────────────────────────────
// Injected by AuthProvider at startup to avoid a circular import.
// Returns the new access token on success, or null if the refresh token is
// also expired (caller should treat this as a hard logout).
let _tokenRefresher: (() => Promise<string | null>) | null = null

export function setTokenRefresher(fn: () => Promise<string | null>): void {
  _tokenRefresher = fn
}

// ─── Core fetch wrapper ─────────────────────────────────────────────────────

interface FetchOptions extends RequestInit {
  // Extend RequestInit with any custom options if needed
}

async function executeRequest(
  url: string,
  options: FetchOptions,
  token: string | null
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (typeof options.headers === "object" && options.headers) {
    Object.assign(headers, options.headers)
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`
  }
  return fetch(url, { ...options, headers })
}

async function parseError(response: Response): Promise<string> {
  let errorMessage = `HTTP ${response.status}`
  try {
    const errorBody = await response.json()
    if (typeof errorBody === "object" && errorBody !== null) {
      if ("detail" in errorBody) {
        errorMessage = String(errorBody.detail)
      } else if ("error" in errorBody) {
        errorMessage = String(errorBody.error)
      } else if ("message" in errorBody) {
        errorMessage = String(errorBody.message)
      }
    }
  } catch {
    errorMessage = response.statusText || errorMessage
  }
  return errorMessage
}

export async function apiFetch(
  path: string,
  options: FetchOptions = {}
): Promise<unknown> {
  const url = `${API_BASE_URL}${path}`
  let response = await executeRequest(url, options, getToken())

  // On 401, attempt a silent token refresh and retry once.
  if (response.status === 401 && _tokenRefresher) {
    const freshToken = await _tokenRefresher()
    if (freshToken) {
      response = await executeRequest(url, options, freshToken)
    }
  }

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  if (response.status === 204) {
    return null
  }

  // Guard against upstream returning HTML (e.g. SPA fallback or proxy error
  // page) on a 2xx — gives a clear error instead of a raw JSON.parse failure.
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    const text = await response.text()
    throw new Error(
      `Expected JSON from ${path} but got ${contentType || "unknown content-type"}` +
        (text.length < 200 ? `: ${text}` : "")
    )
  }

  return response.json()
}

// MCP Management

export interface UpstreamAuth {
  type: "none" | "bearer" | "header"
  token?: string   // bearer
  header?: string  // custom header name
  value?: string   // custom header value
}

export interface MCPRegistration {
  name: string
  slug?: string
  upstream_url: string
  transport: "streamable_http" | "sse" | "stdio"
  description?: string
  upstream_auth?: UpstreamAuth
  requires_user_credential?: boolean
  credential_url?: string
}

export interface MCP {
  slug: string
  name: string
  upstream_url: string
  transport: string
  description?: string
  auth_type?: string
  status: "connected" | "connecting" | "degraded" | "disconnected" | "unknown"
  tool_count: number
  failure_count?: number
  last_error?: string | null
  last_refresh?: string
  requires_user_credential?: boolean
  credential_url?: string | null
}

export async function listMCPs(): Promise<MCP[]> {
  return apiFetch("/admin/mcps") as Promise<MCP[]>
}

export async function getMCP(slug: string): Promise<MCP> {
  return apiFetch(`/admin/mcps/${slug}`) as Promise<MCP>
}

export async function registerMCP(body: MCPRegistration): Promise<MCP> {
  return apiFetch("/admin/mcps", {
    method: "POST",
    body: JSON.stringify(body),
  }) as Promise<MCP>
}

export async function updateMCP(
  slug: string,
  body: Partial<MCPRegistration>
): Promise<MCP> {
  return apiFetch(`/admin/mcps/${slug}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  }) as Promise<MCP>
}

export async function deleteMCP(slug: string): Promise<void> {
  await apiFetch(`/admin/mcps/${slug}`, {
    method: "DELETE",
  })
}

export async function refreshTools(slug: string): Promise<void> {
  await apiFetch(`/admin/mcps/${slug}/refresh`, {
    method: "POST",
  })
}

export interface Tool {
  name: string
  description?: string
}

export async function listTools(slug: string): Promise<Tool[]> {
  return apiFetch(`/admin/mcps/${slug}/tools`) as Promise<Tool[]>
}

// Permissions

export interface Permission {
  group: string
  tool_name: string
}

export async function listPermissions(slug: string): Promise<Permission[]> {
  return apiFetch(`/admin/mcps/${slug}/permissions`) as Promise<Permission[]>
}

export async function grantPermission(
  slug: string,
  group: string,
  toolName: string
): Promise<void> {
  await apiFetch(`/admin/mcps/${slug}/permissions/grant`, {
    method: "POST",
    body: JSON.stringify({ group, tool_name: toolName }),
  })
}

export async function revokePermission(
  slug: string,
  group: string,
  toolName: string
): Promise<void> {
  await apiFetch(`/admin/mcps/${slug}/permissions/revoke`, {
    method: "POST",
    body: JSON.stringify({ group, tool_name: toolName }),
  })
}

export async function bulkSetPermissions(
  slug: string,
  group: string,
  toolNames: string[]
): Promise<void> {
  await apiFetch(`/admin/mcps/${slug}/permissions/bulk`, {
    method: "PUT",
    body: JSON.stringify({ group, tool_names: toolNames }),
  })
}

// Groups

export interface Group {
  path: string
  name?: string
}

export async function listGroups(): Promise<Group[]> {
  return apiFetch("/admin/groups") as Promise<Group[]>
}

export interface GroupPermissions {
  group: string
  permissions: Array<{
    mcp_slug: string
    tools: string[]
  }>
}

export async function listGroupPermissions(
  groupPath: string
): Promise<GroupPermissions> {
  // Keycloak paths start with "/" (e.g. "/developers"). Embedding %2F in a URL
  // path segment is unreliable across nginx/proxies, so we strip the leading
  // slash — the backend normalises it back before querying.
  const stripped = groupPath.startsWith("/") ? groupPath.slice(1) : groupPath
  const encoded = encodeURIComponent(stripped)
  return apiFetch(`/admin/groups/${encoded}/permissions`) as Promise<GroupPermissions>
}

// Connector Configuration

export interface ConnectorConfig {
  claude: Record<string, unknown>
  generic: Record<string, unknown>
}

export async function getConnectorConfig(slug: string): Promise<ConnectorConfig> {
  return apiFetch(`/admin/connector/${slug}`) as Promise<ConnectorConfig>
}

// Gateway Status

export interface Upstream {
  name: string
  url: string
  status: "connected" | "connecting" | "degraded" | "disconnected" | "unknown"
  failure_count: number
}

export interface GatewayStatus {
  upstreams: Upstream[]
  mcp_count: number
  status: string
}

export async function getGatewayStatus(): Promise<GatewayStatus> {
  return apiFetch("/admin/status") as Promise<GatewayStatus>
}

// User credential management (per-user PATs for upstream MCPs)

export interface CredentialStatus {
  /** True if a credential row exists for this slug */
  exists: boolean
  /**
   * True if the upstream rejected the stored credential (expired / revoked /
   * rotated). Cleared automatically when the user sets a new credential.
   */
  is_invalid: boolean
  /** ISO timestamp of the last upstream rejection, or null */
  last_error_at: string | null
  /** ISO timestamp of the last credential update, or null */
  updated_at: string | null
}

export async function listMyCredentials(): Promise<string[]> {
  // Returns array of mcp_slugs for which the current user has a credential
  const data = await apiFetch("/user/credentials") as { slugs: string[] }
  return data.slugs
}

export async function getMyCredentialStatus(slug: string): Promise<CredentialStatus> {
  return apiFetch(`/user/credentials/${slug}`) as Promise<CredentialStatus>
}

export async function setMyCredential(slug: string, credential: string): Promise<void> {
  await apiFetch(`/user/credentials/${slug}`, {
    method: "PUT",
    body: JSON.stringify({ credential }),
  })
}

export async function deleteMyCredential(slug: string): Promise<void> {
  await apiFetch(`/user/credentials/${slug}`, {
    method: "DELETE",
  })
}
