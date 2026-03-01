import React from "react"
import { Link, useLocation } from "react-router-dom"
import { useAuth } from "../lib/auth"
import { useTheme } from "../lib/theme"
import { Button } from "./ui/button"
import { LogOut, LayoutDashboard, Database, Users, Moon, Sun } from "lucide-react"
import { cn } from "../lib/utils"

interface LayoutProps {
  children: React.ReactNode
}

/** Trim the leading "/" from Keycloak group paths for display */
function formatGroup(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { logout, currentUser } = useAuth()
  const { isDark, toggle } = useTheme()
  const location = useLocation()

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/mcps", label: "MCP Servers", icon: Database },
    { href: "/groups", label: "Groups", icon: Users },
  ]

  const displayName =
    currentUser?.name ?? currentUser?.username ?? currentUser?.email ?? "Unknown"

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950">
      {/* Sidebar */}
      <aside className="w-64 border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900 shadow-sm flex flex-col">
        <div className="flex h-16 items-center border-b border-gray-200 dark:border-gray-700 px-6">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              MCP Gateway
            </h1>
          </div>
        </div>

        <nav className="space-y-1 p-4 flex-1">
          {navItems.map(({ href, label, icon: Icon }) => {
            const isActive =
              href === "/"
                ? location.pathname === "/"
                : location.pathname.startsWith(href)
            return (
              <Link
                key={href}
                to={href}
                className={cn(
                  "flex items-center gap-3 rounded-md px-4 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                    : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </Link>
            )
          })}
        </nav>

        {/* User info panel at bottom of sidebar */}
        {currentUser && (
          <div className="border-t border-gray-200 dark:border-gray-700 p-4">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {displayName}
            </p>
            {currentUser.email && (
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 truncate">
                {currentUser.email}
              </p>
            )}
            {currentUser.groups.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {currentUser.groups.map((g) => (
                  <span
                    key={g}
                    className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                  >
                    {formatGroup(g)}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </aside>

      {/* Main Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top Bar */}
        <header className="flex h-16 items-center justify-between border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-8 shadow-sm">
          <div />
          <div className="flex items-center gap-2">
            {/* Dark mode toggle */}
            <Button
              variant="ghost"
              size="sm"
              onClick={toggle}
              title={isDark ? "Switch to light mode" : "Switch to dark mode"}
              className="h-8 w-8 p-0"
            >
              {isDark ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>

            <div className="h-5 w-px bg-gray-200 dark:bg-gray-700" />

            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className="flex items-center gap-2"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </header>

        {/* Content Area */}
        <main className="flex-1 overflow-auto">
          <div className="p-8">{children}</div>
        </main>
      </div>
    </div>
  )
}
