/**
 * Keycloak OAuth2 Authorization Code + PKCE utilities.
 *
 * This module handles the browser-side OAuth2 PKCE flow:
 *   initiateLogin()   → build authorize URL, redirect to Keycloak
 *   exchangeCode()    → trade auth code for token set
 *   refreshTokens()   → silently refresh via refresh token
 *   buildLogoutUrl()  → RP-initiated logout endpoint
 *   decodeJwt()       → parse JWT payload (no sig verification — backend owns that)
 *
 * Config is read from window.__env__ (injected at container start) falling back
 * to Vite build-time env vars, then hardcoded defaults for local development.
 */

const PKCE_VERIFIER_KEY = "pkce_verifier"
const OAUTH_STATE_KEY = "oauth_state"
const RETURN_TO_KEY = "oauth_return_to"

// ─── Config ────────────────────────────────────────────────────────────────

interface KcConfig {
  url: string
  realm: string
  clientId: string
}

function getKcConfig(): KcConfig {
  const env = (window as unknown as { __env__?: Record<string, string> }).__env__ ?? {}
  return {
    url:
      env.VITE_KEYCLOAK_URL ??
      import.meta.env.VITE_KEYCLOAK_URL ??
      "https://your-keycloak.example.com",
    realm:
      env.VITE_KEYCLOAK_REALM ??
      import.meta.env.VITE_KEYCLOAK_REALM ??
      "your-realm",
    clientId:
      env.VITE_KEYCLOAK_CLIENT_ID ??
      import.meta.env.VITE_KEYCLOAK_CLIENT_ID ??
      "mcp-gateway",
  }
}

function oidcBase(cfg: KcConfig): string {
  return `${cfg.url}/realms/${cfg.realm}/protocol/openid-connect`
}

// ─── PKCE helpers ──────────────────────────────────────────────────────────

function base64UrlEncode(buf: Uint8Array): string {
  // btoa needs a binary string
  let binary = ""
  buf.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  const challenge = base64UrlEncode(new Uint8Array(digest))
  return { verifier, challenge }
}

// ─── Login initiation ──────────────────────────────────────────────────────

/**
 * Generate PKCE pair + state, stash them in sessionStorage, then redirect the
 * browser to the Keycloak authorization endpoint.  The browser will never
 * return here — it'll land on /auth/callback after the user authenticates.
 */
export async function initiateLogin(returnTo = "/"): Promise<void> {
  const cfg = getKcConfig()
  const { verifier, challenge } = await generatePKCE()
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))

  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier)
  sessionStorage.setItem(OAUTH_STATE_KEY, state)
  sessionStorage.setItem(RETURN_TO_KEY, returnTo)

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: `${window.location.origin}/auth/callback`,
    response_type: "code",
    scope: "openid profile email",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })

  window.location.href = `${oidcBase(cfg)}/auth?${params}`
}

// ─── Token exchange ────────────────────────────────────────────────────────

export interface TokenSet {
  accessToken: string
  refreshToken: string
  idToken?: string
  /** Unix epoch milliseconds when the access token expires */
  expiresAt: number
}

/**
 * Resolve the API base URL the same way api.ts does, so we can call the
 * backend token exchange proxy without importing from api.ts (circular risk).
 */
function getApiBase(): string {
  const env = (window as unknown as { __env__?: Record<string, string> }).__env__ ?? {}
  return (
    env.VITE_API_URL ??
    import.meta.env.VITE_API_URL ??
    "http://localhost:8000"
  )
}

/**
 * Exchange the authorization code for tokens via our backend proxy.
 *
 * The Keycloak client is confidential and requires a client secret on the
 * token endpoint.  We can't embed that in the SPA, so we POST the auth code
 * + PKCE verifier to /auth/exchange and let the backend add the secret
 * server-side.
 *
 * Reads and clears PKCE verifier + state from sessionStorage; throws if they
 * are missing or if the state param doesn't match (CSRF guard).
 */
export async function exchangeCode(
  code: string,
  state: string
): Promise<{ tokens: TokenSet; returnTo: string }> {
  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY)
  const expectedState = sessionStorage.getItem(OAUTH_STATE_KEY)
  const returnTo = sessionStorage.getItem(RETURN_TO_KEY) ?? "/"

  if (!verifier) throw new Error("Missing PKCE verifier — session may have expired")
  if (state !== expectedState) throw new Error("OAuth state mismatch — possible CSRF attack")

  // Clean up sessionStorage immediately before any await
  sessionStorage.removeItem(PKCE_VERIFIER_KEY)
  sessionStorage.removeItem(OAUTH_STATE_KEY)
  sessionStorage.removeItem(RETURN_TO_KEY)

  const res = await fetch(`${getApiBase()}/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      redirect_uri: `${window.location.origin}/auth/callback`,
      code_verifier: verifier,
    }),
  })

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as Record<string, unknown>
    throw new Error(
      typeof err.detail === "string"
        ? err.detail
        : `Token exchange failed (${res.status})`
    )
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token: string
    id_token?: string
    expires_in: number
  }

  return {
    tokens: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    },
    returnTo,
  }
}

// ─── Token refresh ─────────────────────────────────────────────────────────

/**
 * Use the refresh token to silently obtain a fresh access token via the backend.
 * The backend handles the Keycloak token endpoint call with client_secret.
 * Throws if the refresh token is expired or the backend rejects it.
 */
export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  const res = await fetch(`${getApiBase()}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })

  if (!res.ok) throw new Error("Token refresh failed — session may have expired")

  const data = (await res.json()) as {
    access_token: string
    refresh_token?: string
    id_token?: string
    expires_in: number
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    idToken: data.id_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
}

// ─── Logout ────────────────────────────────────────────────────────────────

/**
 * Build the Keycloak RP-initiated logout URL.  Passing the id_token_hint lets
 * Keycloak skip the "are you sure?" confirmation screen.
 */
export function buildLogoutUrl(idToken?: string): string {
  const cfg = getKcConfig()
  const params = new URLSearchParams({
    post_logout_redirect_uri: window.location.origin,
    client_id: cfg.clientId,
  })
  if (idToken) params.set("id_token_hint", idToken)
  return `${oidcBase(cfg)}/logout?${params}`
}

// ─── JWT decode ────────────────────────────────────────────────────────────

export interface JwtClaims {
  sub: string
  email?: string
  name?: string
  preferred_username?: string
  /** Keycloak group paths, e.g. ["/admins", "/developers"] */
  groups?: string[] | string
  /** Token expiry (unix seconds) */
  exp?: number
  [key: string]: unknown
}

/**
 * Decode the payload of a JWT without verifying the signature.
 * Signature verification is the backend's responsibility.
 * Used purely for display purposes (name, email, groups).
 */
export function decodeJwt(token: string): JwtClaims {
  try {
    const part = token.split(".")[1]
    // Pad base64url → base64
    const padded = part.replace(/-/g, "+").replace(/_/g, "/")
    const padLength = (4 - (padded.length % 4)) % 4
    const decoded = atob(padded + "=".repeat(padLength))
    return JSON.parse(decoded) as JwtClaims
  } catch {
    return { sub: "unknown" }
  }
}
