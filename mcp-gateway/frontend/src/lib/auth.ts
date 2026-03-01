/**
 * AuthContext — wraps the PKCE OAuth2 flow and exposes:
 *
 *   isAuthenticated  — whether a valid access token is stored
 *   currentUser      — decoded JWT claims (sub, email, name, groups, …)
 *   login(returnTo)  — redirects to Keycloak; returns a Promise that never
 *                      resolves (navigation happens before it can)
 *   logout()         — clears tokens + RP-initiated Keycloak logout
 *   completeLogin()  — called by CallbackPage after a successful code exchange
 *
 * Token storage keys in localStorage:
 *   mcp_gateway_token          — JWT access token (also used by apiFetch)
 *   mcp_gateway_refresh_token  — refresh token
 *   mcp_gateway_expires_at     — access token expiry (Unix ms)
 *   mcp_gateway_id_token       — id_token (used as id_token_hint on logout)
 *
 * The access token is proactively refreshed every 60 s if it expires within
 * the next 2 minutes.  On refresh failure the user is logged out.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import {
  setToken as setApiToken,
  clearToken as clearApiToken,
  setTokenRefresher,
} from "./api"
import {
  buildLogoutUrl,
  decodeJwt,
  initiateLogin,
  refreshTokens,
  type JwtClaims,
  type TokenSet,
} from "./keycloak"

// ─── Storage helpers ───────────────────────────────────────────────────────

const KEYS = {
  accessToken: "mcp_gateway_token",
  refreshToken: "mcp_gateway_refresh_token",
  expiresAt: "mcp_gateway_expires_at",
  idToken: "mcp_gateway_id_token",
} as const

interface StoredTokens extends TokenSet {
  idToken?: string
}

function loadStoredTokens(): StoredTokens | null {
  const accessToken = localStorage.getItem(KEYS.accessToken)
  const refreshToken = localStorage.getItem(KEYS.refreshToken)
  const expiresAt = Number(localStorage.getItem(KEYS.expiresAt) ?? "0")
  if (!accessToken || !refreshToken) return null
  return {
    accessToken,
    refreshToken,
    idToken: localStorage.getItem(KEYS.idToken) ?? undefined,
    expiresAt,
  }
}

function persistTokens(tokens: TokenSet): void {
  localStorage.setItem(KEYS.accessToken, tokens.accessToken)
  localStorage.setItem(KEYS.refreshToken, tokens.refreshToken)
  localStorage.setItem(KEYS.expiresAt, String(tokens.expiresAt))
  if (tokens.idToken) localStorage.setItem(KEYS.idToken, tokens.idToken)
  setApiToken(tokens.accessToken)
}

function eraseTokens(): void {
  Object.values(KEYS).forEach((k) => localStorage.removeItem(k))
  clearApiToken()
}

// ─── CurrentUser ───────────────────────────────────────────────────────────

export interface CurrentUser {
  sub: string
  email?: string
  name?: string
  username?: string
  /** Keycloak group paths, e.g. ["/admins", "/developers"] */
  groups: string[]
  /** Raw decoded JWT claims */
  claims: JwtClaims
}

function claimsToUser(claims: JwtClaims): CurrentUser {
  let groups: string[] = []
  if (Array.isArray(claims.groups)) {
    groups = claims.groups as string[]
  } else if (typeof claims.groups === "string") {
    groups = (claims.groups as string).split(" ").filter(Boolean)
  }
  return {
    sub: claims.sub,
    email: claims.email,
    name: claims.name,
    username: claims.preferred_username,
    groups,
    claims,
  }
}

// ─── Context ───────────────────────────────────────────────────────────────

interface AuthContextType {
  isAuthenticated: boolean
  currentUser: CurrentUser | null
  /** Initiates the PKCE redirect — the returned Promise never resolves */
  login: (returnTo?: string) => Promise<void>
  /** Clears local tokens and performs RP-initiated Keycloak logout */
  logout: () => void
  /** Called by CallbackPage after a successful code → token exchange */
  completeLogin: (tokens: TokenSet) => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}

// ─── Provider ──────────────────────────────────────────────────────────────

export interface AuthProviderProps {
  children: ReactNode
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(() => {
    const stored = loadStoredTokens()
    if (!stored) return null
    setApiToken(stored.accessToken)
    return claimsToUser(decodeJwt(stored.accessToken))
  })

  // ── Proactive token refresh ──────────────────────────────────────────────
  // Check every 60 s; if the token expires within 2 minutes, refresh silently.
  useEffect(() => {
    if (!currentUser) return
    const interval = setInterval(async () => {
      const stored = loadStoredTokens()
      if (!stored) return
      const twoMinutes = 2 * 60 * 1000
      if (stored.expiresAt - Date.now() < twoMinutes) {
        try {
          const fresh = await refreshTokens(stored.refreshToken)
          persistTokens(fresh)
          setCurrentUser(claimsToUser(decodeJwt(fresh.accessToken)))
        } catch {
          // Refresh token expired or revoked — force re-login
          eraseTokens()
          setCurrentUser(null)
        }
      }
    }, 60_000)

    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!currentUser])

  // ── Reactive 401 refresh callback ────────────────────────────────────────
  // Registered with apiFetch so it can silently refresh-and-retry on 401
  // without creating a circular module dependency.
  useEffect(() => {
    setTokenRefresher(async () => {
      const stored = loadStoredTokens()
      if (!stored?.refreshToken) return null
      try {
        const fresh = await refreshTokens(stored.refreshToken)
        persistTokens(fresh)
        setCurrentUser(claimsToUser(decodeJwt(fresh.accessToken)))
        return fresh.accessToken
      } catch {
        eraseTokens()
        setCurrentUser(null)
        return null
      }
    })
    // Clear on unmount (shouldn't happen in practice, but good hygiene)
    return () => setTokenRefresher(async () => null)
  }, [])

  const login = useCallback(async (returnTo = "/"): Promise<void> => {
    await initiateLogin(returnTo)
    // initiateLogin() redirects the browser — this line is unreachable
  }, [])

  const logout = useCallback((): void => {
    const idToken = localStorage.getItem(KEYS.idToken) ?? undefined
    eraseTokens()
    setCurrentUser(null)
    // RP-initiated logout: Keycloak ends the SSO session too
    window.location.href = buildLogoutUrl(idToken)
  }, [])

  const completeLogin = useCallback((tokens: TokenSet): void => {
    persistTokens(tokens)
    setCurrentUser(claimsToUser(decodeJwt(tokens.accessToken)))
  }, [])

  return React.createElement(AuthContext.Provider, {
    value: {
      isAuthenticated: !!currentUser,
      currentUser,
      login,
      logout,
      completeLogin,
    },
    children,
  })
}
