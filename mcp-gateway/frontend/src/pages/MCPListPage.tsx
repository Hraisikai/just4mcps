import React, { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import {
  listMCPs,
  registerMCP,
  type MCPRegistration,
} from "../lib/api"
import { Button } from "../components/ui/button"
import { Card, CardContent } from "../components/ui/card"
import { Input } from "../components/ui/input"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/ui/dialog"
import { StatusDot } from "../components/StatusDot"
import { AlertCircle, Plus, Eye, CheckCircle2, Copy } from "lucide-react"

const TRANSPORT_OPTIONS = [
  { value: "streamable_http", label: "Streamable HTTP" },
  { value: "sse", label: "SSE (Server-Sent Events)" },
  { value: "stdio", label: "STDIO" },
] as const

const AUTH_TYPE_OPTIONS = [
  { value: "none", label: "None" },
  { value: "bearer", label: "Bearer Token" },
  { value: "header", label: "Custom Header" },
] as const

const API_BASE =
  (window as unknown as { __env__?: { VITE_API_URL?: string } }).__env__
    ?.VITE_API_URL ||
  import.meta.env.VITE_API_URL ||
  "http://localhost:8000"

// Shared select class — reused across both pages
const selectCls =
  "flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:focus:border-blue-400"

const labelCls = "mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300"

interface RegisterFormState {
  name: string
  slug: string
  upstream_url: string
  transport: MCPRegistration["transport"]
  description: string
  auth_type: "none" | "bearer" | "header"
  auth_token: string
  auth_header: string
  auth_value: string
  requires_user_credential: boolean
  credential_url: string
}

const defaultForm: RegisterFormState = {
  name: "",
  slug: "",
  upstream_url: "",
  transport: "streamable_http",
  description: "",
  auth_type: "none",
  auth_token: "",
  auth_header: "X-Api-Key",
  auth_value: "",
  requires_user_credential: false,
  credential_url: "",
}

function buildRegistration(form: RegisterFormState): MCPRegistration {
  const reg: MCPRegistration = {
    name: form.name,
    upstream_url: form.upstream_url,
    transport: form.transport,
  }
  if (form.slug.trim()) reg.slug = form.slug.trim()
  if (form.description.trim()) reg.description = form.description.trim()
  if (form.requires_user_credential) reg.requires_user_credential = true
  if (form.requires_user_credential && form.credential_url.trim()) {
    reg.credential_url = form.credential_url.trim()
  }

  if (form.auth_type === "bearer" && form.auth_token.trim()) {
    reg.upstream_auth = { type: "bearer", token: form.auth_token.trim() }
  } else if (
    form.auth_type === "header" &&
    form.auth_header.trim() &&
    form.auth_value.trim()
  ) {
    reg.upstream_auth = {
      type: "header",
      header: form.auth_header.trim(),
      value: form.auth_value.trim(),
    }
  }
  return reg
}

export const MCPListPage: React.FC = () => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [formData, setFormData] = useState<RegisterFormState>(defaultForm)
  const [error, setError] = useState("")
  const [successSlug, setSuccessSlug] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const { data: mcps, isLoading, error: queryError } = useQuery({
    queryKey: ["mcps"],
    queryFn: listMCPs,
  })

  const registerMutation = useMutation({
    mutationFn: (reg: MCPRegistration) => registerMCP(reg),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["mcps"] })
      setSuccessSlug(created.slug)
      setError("")
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to register MCP")
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    if (!formData.name.trim()) { setError("Name is required"); return }
    if (!formData.upstream_url.trim()) { setError("Upstream URL is required"); return }
    registerMutation.mutate(buildRegistration(formData))
  }

  const handleClose = () => {
    setDialogOpen(false)
    setFormData(defaultForm)
    setError("")
    setSuccessSlug(null)
    setCopied(false)
  }

  const gatewayUrl = successSlug ? `${API_BASE}/${successSlug}/mcp` : ""

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(gatewayUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }

  const set = <K extends keyof RegisterFormState>(k: K, v: RegisterFormState[K]) =>
    setFormData((prev) => ({ ...prev, [k]: v }))

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">MCP Servers</h1>
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-800" />
          ))}
        </div>
      </div>
    )
  }

  if (queryError) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">MCP Servers</h1>
        <Card className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
          <CardContent className="flex items-center gap-3 pt-6">
            <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0" />
            <p className="text-sm text-red-700 dark:text-red-300">
              {queryError instanceof Error ? queryError.message : "Failed to load MCP servers"}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">MCP Servers</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Registered upstream MCP servers
          </p>
        </div>

        <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) handleClose(); else setDialogOpen(true) }}>
          <DialogTrigger asChild>
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" />
              Register MCP
            </Button>
          </DialogTrigger>

          <DialogContent className="max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Register New MCP Server</DialogTitle>
              <DialogDescription>
                Add an upstream MCP server to the gateway
              </DialogDescription>
            </DialogHeader>

            {successSlug ? (
              /* ── Success state ── */
              <div className="p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="h-6 w-6 text-green-500 shrink-0" />
                  <div>
                    <p className="font-medium text-gray-900 dark:text-gray-100">MCP registered!</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Clients should connect to:
                    </p>
                  </div>
                </div>

                <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-3">
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-1 font-medium uppercase tracking-wide">
                    Gateway URL
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-sm font-mono text-gray-800 dark:text-gray-200 break-all">
                      {gatewayUrl}
                    </code>
                    <Button variant="ghost" size="sm" onClick={handleCopy} className="shrink-0">
                      {copied ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>

                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Use this URL in your MCP client config. Authentication is handled via OAuth2 PKCE.
                  Check the <strong>Connector Config</strong> tab on the server detail page for
                  ready-to-paste configs.
                </p>

                <DialogFooter>
                  <Button variant="outline" onClick={handleClose}>Close</Button>
                  <Button onClick={() => navigate(`/mcps/${successSlug}`)}>
                    View Server
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              /* ── Registration form ── */
              <form onSubmit={handleSubmit} className="p-6 space-y-4">
                {/* Name */}
                <div>
                  <label className={labelCls}>Name *</label>
                  <Input
                    placeholder="GitLab MCP"
                    value={formData.name}
                    onChange={(e) => set("name", e.target.value)}
                    autoFocus
                  />
                </div>

                {/* Slug (optional override) */}
                <div>
                  <label className={labelCls}>
                    Slug{" "}
                    <span className="font-normal text-gray-400 dark:text-gray-500">
                      (auto-derived from name if empty)
                    </span>
                  </label>
                  <Input
                    placeholder="gitlab"
                    value={formData.slug}
                    onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                  />
                </div>

                {/* Upstream URL */}
                <div>
                  <label className={labelCls}>Upstream URL *</label>
                  <Input
                    placeholder="http://gitlab-mcp:3000/mcp"
                    value={formData.upstream_url}
                    onChange={(e) => set("upstream_url", e.target.value)}
                  />
                </div>

                {/* Transport */}
                <div>
                  <label className={labelCls}>Transport</label>
                  <select
                    value={formData.transport}
                    onChange={(e) => set("transport", e.target.value as MCPRegistration["transport"])}
                    className={selectCls}
                  >
                    {TRANSPORT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                {/* Upstream Auth */}
                <div>
                  <label className={labelCls}>Upstream Auth</label>
                  <select
                    value={formData.auth_type}
                    onChange={(e) => set("auth_type", e.target.value as RegisterFormState["auth_type"])}
                    className={selectCls}
                  >
                    {AUTH_TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                {formData.auth_type === "bearer" && (
                  <div>
                    <label className={labelCls}>Bearer Token</label>
                    <Input
                      type="password"
                      placeholder="••••••••"
                      value={formData.auth_token}
                      onChange={(e) => set("auth_token", e.target.value)}
                    />
                  </div>
                )}

                {formData.auth_type === "header" && (
                  <div className="space-y-3">
                    <div>
                      <label className={labelCls}>Header Name</label>
                      <Input
                        placeholder="X-Api-Key"
                        value={formData.auth_header}
                        onChange={(e) => set("auth_header", e.target.value)}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Header Value</label>
                      <Input
                        type="password"
                        placeholder="••••••••"
                        value={formData.auth_value}
                        onChange={(e) => set("auth_value", e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {/* Description */}
                <div>
                  <label className={labelCls}>
                    Description{" "}
                    <span className="font-normal text-gray-400 dark:text-gray-500">(optional)</span>
                  </label>
                  <textarea
                    placeholder="What does this MCP server do?"
                    value={formData.description}
                    onChange={(e) => set("description", e.target.value)}
                    rows={3}
                    className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-blue-400"
                  />
                </div>

                {/* Require user credential */}
                <div className="flex items-start gap-3 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-3">
                  <input
                    type="checkbox"
                    id="requires-cred"
                    checked={formData.requires_user_credential}
                    onChange={(e) => set("requires_user_credential", e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 dark:focus:ring-blue-500"
                  />
                  <div className="flex-1 min-w-0">
                    <label htmlFor="requires-cred" className="text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer">
                      Require users to set their own credential (e.g. GitLab PAT)
                    </label>
                    <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                      Users will be prompted to configure a personal access token before tool calls are forwarded.
                    </p>
                  </div>
                </div>

                {/* Credential generation URL (shown when requires_user_credential is checked) */}
                {formData.requires_user_credential && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Token generation URL <span className="text-gray-400 font-normal">(optional)</span>
                    </label>
                    <input
                      type="url"
                      placeholder="https://gitlab.example.com/-/user_settings/personal_access_tokens"
                      value={formData.credential_url}
                      onChange={(e) => set("credential_url", e.target.value)}
                      className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-blue-400"
                    />
                    <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                      If set, users will see a "Generate new token" link pointing here.
                    </p>
                  </div>
                )}

                {error && (
                  <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-800 dark:bg-red-950">
                    <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0" />
                    <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
                  </div>
                )}

                <DialogFooter>
                  <Button type="button" variant="outline" onClick={handleClose}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={registerMutation.isPending}>
                    {registerMutation.isPending ? "Registering…" : "Register"}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
              {["Name", "Slug", "Transport", "Status", "Tools", ""].map((h) => (
                <th
                  key={h}
                  className={`px-6 py-3 text-sm font-semibold text-gray-700 dark:text-gray-300 ${h === "" ? "text-right" : "text-left"}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mcps && mcps.length > 0 ? (
              mcps.map((mcp) => (
                <tr
                  key={mcp.slug}
                  className="border-b border-gray-200 dark:border-gray-700 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50 last:border-0"
                >
                  <td className="px-6 py-4 text-sm font-medium text-gray-900 dark:text-gray-100">
                    {mcp.name}
                  </td>
                  <td className="px-6 py-4">
                    <code className="rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-xs text-gray-700 dark:text-gray-300 font-mono">
                      {mcp.slug}
                    </code>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">
                    {mcp.transport}
                  </td>
                  <td className="px-6 py-4">
                    <StatusDot status={mcp.status} />
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">
                    {mcp.tool_count} tool{mcp.tool_count !== 1 ? "s" : ""}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/mcps/${mcp.slug}`)}
                      title="View details"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center text-gray-500 dark:text-gray-400">
                  No MCP servers registered yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
