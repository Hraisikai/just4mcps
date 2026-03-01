import React from "react"
import ReactDOM from "react-dom/client"
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
} from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { AuthProvider, useAuth } from "./lib/auth"
import { ThemeProvider } from "./lib/theme"
import { Layout } from "./components/Layout"
import { LoginPage } from "./pages/LoginPage"
import { CallbackPage } from "./pages/CallbackPage"
import { DashboardPage } from "./pages/DashboardPage"
import { MCPListPage } from "./pages/MCPListPage"
import { MCPDetailPage } from "./pages/MCPDetailPage"
import { GroupsPage } from "./pages/GroupsPage"
import "./index.css"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 10, // 10 minutes
    },
  },
})

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { isAuthenticated } = useAuth()
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />
}

const Router: React.FC = () => {
  const { isAuthenticated } = useAuth()

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
      />

      {/* OAuth2 PKCE callback — no auth guard, handles its own error state */}
      <Route path="/auth/callback" element={<CallbackPage />} />

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout>
              <DashboardPage />
            </Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/mcps"
        element={
          <ProtectedRoute>
            <Layout>
              <MCPListPage />
            </Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/mcps/:slug"
        element={
          <ProtectedRoute>
            <Layout>
              <MCPDetailPage />
            </Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/groups"
        element={
          <ProtectedRoute>
            <Layout>
              <GroupsPage />
            </Layout>
          </ProtectedRoute>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

const root = document.getElementById("root")

if (!root) {
  throw new Error("Root element not found")
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BrowserRouter>
            <Router />
          </BrowserRouter>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>
)
