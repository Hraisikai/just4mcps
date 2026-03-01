/**
 * CallbackPage — handles the OAuth2 redirect from Keycloak.
 *
 * Keycloak lands the browser here with ?code=…&state=… after the user
 * authenticates.  We exchange the code for tokens, store them, then navigate
 * to the original destination (or "/" if none was saved).
 *
 * On error (state mismatch, Keycloak error params, network failure) we render
 * an error card so the user can retry cleanly.
 */

import React, { useEffect, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { exchangeCode } from "../lib/keycloak"
import { useAuth } from "../lib/auth"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { Button } from "../components/ui/button"
import { AlertCircle, Loader2 } from "lucide-react"

export const CallbackPage: React.FC = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { completeLogin } = useAuth()
  const [error, setError] = useState<string | null>(null)
  // Guard against React StrictMode double-invoke
  const handled = useRef(false)

  useEffect(() => {
    if (handled.current) return
    handled.current = true

    const code = searchParams.get("code")
    const state = searchParams.get("state")
    // Keycloak sets ?error= if the user cancelled or something went wrong upstream
    const kcError = searchParams.get("error")
    const kcErrorDesc = searchParams.get("error_description")

    if (kcError) {
      setError(
        kcErrorDesc
          ? `Keycloak error: ${kcErrorDesc}`
          : `Keycloak returned an error: ${kcError}`
      )
      return
    }

    if (!code || !state) {
      setError("Invalid callback — missing authorization code or state parameter.")
      return
    }

    exchangeCode(code, state)
      .then(({ tokens, returnTo }) => {
        completeLogin(tokens)
        navigate(returnTo, { replace: true })
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Authentication failed — please try again.")
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-md">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <AlertCircle className="h-6 w-6 text-red-500" />
                <div>
                  <CardTitle>Authentication Failed</CardTitle>
                  <CardDescription>Could not complete login</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                <p className="text-sm text-red-700">{error}</p>
              </div>
              <Button
                className="w-full"
                onClick={() => navigate("/login", { replace: true })}
              >
                Back to Login
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        <p className="text-sm text-gray-500">Completing sign-in…</p>
      </div>
    </div>
  )
}
