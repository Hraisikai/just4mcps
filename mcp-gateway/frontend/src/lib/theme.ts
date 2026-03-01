/**
 * ThemeContext — manages light/dark mode with localStorage persistence.
 *
 * Applies the `dark` class to <html> so Tailwind's class-based dark variant
 * works everywhere. Supports three modes:
 *   light  — always light
 *   dark   — always dark
 *   system — follows OS preference (default)
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
  createElement,
  type ReactNode,
} from "react"

export type ThemeMode = "light" | "dark" | "system"

interface ThemeContextType {
  mode: ThemeMode
  isDark: boolean
  setMode: (mode: ThemeMode) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

const STORAGE_KEY = "mcp_theme"

function getSystemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

function resolveIsDark(mode: ThemeMode): boolean {
  if (mode === "system") return getSystemDark()
  return mode === "dark"
}

function applyTheme(dark: boolean): void {
  const root = document.documentElement
  if (dark) {
    root.classList.add("dark")
  } else {
    root.classList.remove("dark")
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null
    return stored ?? "system"
  })

  const mediaQueryRef = useRef<MediaQueryList | null>(null)

  const isDark = resolveIsDark(mode)

  // Apply the theme class on mount and whenever mode changes
  useEffect(() => {
    applyTheme(resolveIsDark(mode))
  }, [mode])

  // Listen for system preference changes when in system mode
  useEffect(() => {
    if (mode !== "system") return

    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    mediaQueryRef.current = mq

    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches)
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [mode])

  const setMode = useCallback((newMode: ThemeMode) => {
    localStorage.setItem(STORAGE_KEY, newMode)
    setModeState(newMode)
  }, [])

  const toggle = useCallback(() => {
    // When toggling, switch between light and dark (exit system mode)
    setMode(resolveIsDark(mode) ? "light" : "dark")
  }, [mode, setMode])

  return createElement(ThemeContext.Provider, {
    value: { mode, isDark, setMode, toggle },
    children,
  })
}

export function useTheme(): ThemeContextType {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider")
  return ctx
}
