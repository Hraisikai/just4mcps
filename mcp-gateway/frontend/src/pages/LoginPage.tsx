import React, { useState } from "react"
import { useAuth } from "../lib/auth"
import { Button } from "../components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card"
import { LogIn, ShieldCheck } from "lucide-react"

export const LoginPage: React.FC = () => {
  const { login, isAuthenticated } = useAuth()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleLogin = async () => {
    setLoading(true)
    setError(null)
    try {
      await login("/")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to initiate login")
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-6 w-6 text-blue-600 dark:text-blue-400 shrink-0" />
              <div>
                <CardTitle className="text-xl">MCP Gateway</CardTitle>
                <CardDescription>Sign in to continue</CardDescription>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {isAuthenticated ? (
              <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950 p-4">
                <p className="text-sm font-medium text-green-800 dark:text-green-300">
                  Already authenticated — redirecting…
                </p>
              </div>
            ) : (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Sign in with your Keycloak account. You'll be redirected to
                Keycloak and back automatically.
              </p>
            )}

            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950 p-3">
                <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
              </div>
            )}

            <Button
              className="w-full gap-2"
              onClick={handleLogin}
              disabled={isAuthenticated || loading}
            >
              <LogIn className="h-4 w-4" />
              {loading ? "Redirecting to Keycloak…" : "Sign in with Keycloak"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
