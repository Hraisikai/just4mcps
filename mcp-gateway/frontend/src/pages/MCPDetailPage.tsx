import React, { useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  getMCP,
  deleteMCP,
  listTools,
  listPermissions,
  refreshTools,
  bulkSetPermissions,
  listGroups,
  getConnectorConfig,
  getMyCredentialStatus,
  setMyCredential,
  deleteMyCredential,
  type CredentialStatus,
  type Tool,
  type Permission,
  type Group,
} from "../lib/api"
import { Button } from "../components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card"
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
import {
  AlertCircle,
  RefreshCw,
  Edit2,
  ChevronLeft,
  Copy,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import * as Tabs from "@radix-ui/react-tabs"

// ── Shared helpers ──────────────────────────────────────────────────────────

const API_BASE =
  (window as unknown as { __env__?: { VITE_API_URL?: string } }).__env__
    ?.VITE_API_URL ||
  import.meta.env.VITE_API_URL ||
  "http://localhost:8000"

function useCopy(text: string, timeout = 2000) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), timeout)
    } catch { /* ignore */ }
  }
  return { copied, copy }
}

const labelCls = "text-sm font-medium text-gray-500 dark:text-gray-400"
const valueCls = "mt-1 text-gray-900 dark:text-gray-100"

// ── Main page ───────────────────────────────────────────────────────────────

export const MCPDetailPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const mcpQuery = useQuery({
    queryKey: ["mcp", slug],
    queryFn: () => getMCP(slug!),
    enabled: !!slug,
  })

  const toolsQuery = useQuery({
    queryKey: ["mcp-tools", slug],
    queryFn: () => listTools(slug!),
    enabled: !!slug,
  })

  const permissionsQuery = useQuery({
    queryKey: ["mcp-permissions", slug],
    queryFn: () => listPermissions(slug!),
    enabled: !!slug,
  })

  const groupsQuery = useQuery({
    queryKey: ["groups"],
    queryFn: listGroups,
  })

  const refreshMutation = useMutation({
    mutationFn: () => refreshTools(slug!),
    onSuccess: () => {
      // Refresh is async on the backend — poll the mcp record and tool list a
      // few times so the UI updates once the background connect finishes.
      const poll = (attempts: number) => {
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["mcp", slug] })
          queryClient.invalidateQueries({ queryKey: ["mcp-tools", slug] })
          if (attempts > 1) poll(attempts - 1)
        }, 2000)
      }
      poll(4) // up to 8 seconds of polling, every 2s
    },
  })

  const deleteMcpMutation = useMutation({
    mutationFn: () => deleteMCP(slug!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcps"] })
      navigate("/mcps")
    },
  })

  if (!slug || mcpQuery.isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-10 w-48 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
        <div className="h-36 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
      </div>
    )
  }

  if (mcpQuery.error || !mcpQuery.data) {
    return (
      <div className="space-y-6">
        <Button variant="outline" size="sm" onClick={() => navigate("/mcps")}>
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>
        <Card className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
          <CardContent className="flex items-center gap-3 pt-6">
            <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
            <p className="text-sm text-red-700 dark:text-red-300">Failed to load MCP details</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const mcp = mcpQuery.data
  // API_BASE is a relative path (/api) so that fetch calls resolve against the
  // current origin. For the copyable gateway URL we need the full absolute URL.
  const gatewayUrl = `${window.location.origin}${API_BASE}/${slug}/mcp`

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={() => navigate("/mcps")}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 truncate">
            {mcp.name}
          </h1>
          <code className="mt-1 text-sm text-gray-500 dark:text-gray-400 font-mono">
            {mcp.slug}
          </code>
        </div>
        <StatusDot status={mcp.status} />
        <Button
          variant="outline"
          size="sm"
          className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-950"
          disabled={deleteMcpMutation.isPending}
          onClick={() => {
            if (confirm(`Delete "${mcp.name}"? This will remove all its tools and permissions and cannot be undone.`)) {
              deleteMcpMutation.mutate()
            }
          }}
        >
          <Trash2 className="h-4 w-4 mr-1" />
          {deleteMcpMutation.isPending ? "Deleting…" : "Delete"}
        </Button>
      </div>

      {/* Connection error banner */}
      {mcp.last_error && mcp.status !== "connected" && (
        <Card className="border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950">
          <CardContent className="flex items-start gap-3 pt-4 pb-4">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                Connection error
                {mcp.failure_count ? ` (${mcp.failure_count} attempt${mcp.failure_count !== 1 ? "s" : ""})` : ""}
              </p>
              <p className="mt-0.5 text-xs font-mono text-amber-700 dark:text-amber-300 break-all">
                {mcp.last_error}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Overview Card */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className={labelCls}>Transport</p>
              <p className={valueCls}>{mcp.transport}</p>
            </div>
            <div>
              <p className={labelCls}>Tools</p>
              <p className={valueCls}>
                {toolsQuery.data?.length ?? mcp.tool_count ?? 0} discovered
              </p>
            </div>
            <div className="sm:col-span-2">
              <p className={labelCls}>Upstream URL</p>
              <p className="mt-1 font-mono text-sm text-gray-800 dark:text-gray-200 break-all">
                {mcp.upstream_url}
              </p>
            </div>
          </div>

          {/* Gateway connection URL — the important one */}
          <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-6">
            <p className={labelCls}>Gateway URL (use this in your MCP client)</p>
            <GatewayUrlRow url={gatewayUrl} />
          </div>

          {mcp.description && (
            <div className="mt-4 border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className={labelCls}>Description</p>
              <p className="mt-1 text-gray-700 dark:text-gray-300">{mcp.description}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs.Root defaultValue="tools">
        <Tabs.List className="flex border-b border-gray-200 dark:border-gray-700">
          {["tools", "permissions", "connector", "credentials"].map((tab) => (
            <Tabs.Trigger
              key={tab}
              value={tab}
              className="px-5 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-400 border-b-2 border-transparent capitalize data-[state=active]:border-blue-600 data-[state=active]:text-blue-600 dark:data-[state=active]:border-blue-400 dark:data-[state=active]:text-blue-400 transition-colors"
            >
              {tab === "connector"
                ? "Connector Config"
                : tab === "credentials"
                  ? "My Credentials"
                  : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        {/* ── Tools tab ── */}
        <Tabs.Content value="tools" className="mt-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Discovered Tools
            </h2>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
            >
              <RefreshCw className={`h-4 w-4 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>

          {toolsQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
              ))}
            </div>
          ) : toolsQuery.error ? (
            <ErrorCard message="Failed to load tools" />
          ) : toolsQuery.data && toolsQuery.data.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700 dark:text-gray-300">Name</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700 dark:text-gray-300">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {toolsQuery.data.map((tool) => (
                    <tr
                      key={tool.name}
                      className="border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 last:border-0"
                    >
                      <td className="px-6 py-4">
                        <code className="text-sm font-mono text-gray-900 dark:text-gray-100">
                          {tool.name}
                        </code>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">
                        {tool.description || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyCard message="No tools discovered yet — try refreshing" />
          )}
        </Tabs.Content>

        {/* ── Permissions tab ── */}
        <Tabs.Content value="permissions" className="mt-6">
          <PermissionsTab
            slug={slug}
            tools={toolsQuery.data || []}
            permissions={permissionsQuery.data || []}
            groups={groupsQuery.data || []}
          />
        </Tabs.Content>

        {/* ── Connector tab ── */}
        <Tabs.Content value="connector" className="mt-6">
          <ConnectorTab slug={slug} />
        </Tabs.Content>

        {/* ── Credentials tab ── */}
        <Tabs.Content value="credentials" className="mt-6">
          <CredentialsTab
            slug={slug}
            mcpName={mcp.name}
            requiresCredential={mcp.requires_user_credential ?? false}
            credentialUrl={mcp.credential_url ?? null}
          />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

const GatewayUrlRow: React.FC<{ url: string }> = ({ url }) => {
  const { copied, copy } = useCopy(url)
  return (
    <div className="mt-2 flex items-center gap-2 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2">
      <code className="flex-1 text-sm font-mono text-gray-800 dark:text-gray-200 break-all">
        {url}
      </code>
      <Button variant="ghost" size="sm" onClick={copy} title="Copy URL" className="shrink-0 h-7 w-7 p-0">
        {copied ? (
          <CheckCircle2 className="h-4 w-4 text-green-500" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </Button>
    </div>
  )
}

const ErrorCard: React.FC<{ message: string }> = ({ message }) => (
  <Card className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
    <CardContent className="flex items-center gap-3 pt-6">
      <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0" />
      <p className="text-sm text-red-700 dark:text-red-300">{message}</p>
    </CardContent>
  </Card>
)

const EmptyCard: React.FC<{ message: string }> = ({ message }) => (
  <Card className="border-dashed">
    <CardContent className="flex items-center justify-center py-12">
      <p className="text-gray-500 dark:text-gray-400">{message}</p>
    </CardContent>
  </Card>
)

// ── Permissions tab ─────────────────────────────────────────────────────────

interface PermissionsTabProps {
  slug: string
  tools: Tool[]
  permissions: Permission[]
  groups: Group[]
}

const PermissionsTab: React.FC<PermissionsTabProps> = ({
  slug, tools, permissions, groups,
}) => {
  const queryClient = useQueryClient()
  const [editingGroup, setEditingGroup] = useState<string | null>(null)
  const [newGroupPath, setNewGroupPath] = useState("")
  const [showAddGroup, setShowAddGroup] = useState(false)

  const bulkSetMutation = useMutation({
    mutationFn: (data: { group: string; toolNames: string[] }) =>
      bulkSetPermissions(slug, data.group, data.toolNames),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-permissions", slug] })
      setEditingGroup(null)
    },
  })

  const handleAddGroup = () => {
    if (!newGroupPath.trim()) return
    setEditingGroup(newGroupPath.trim())
    setNewGroupPath("")
    setShowAddGroup(false)
  }

  const groupPermissions = groups.map((group) => ({
    group: group.path,
    tools: permissions.filter((p) => p.group === group.path).map((p) => p.tool_name),
  }))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Group Permissions
        </h2>
        <Dialog open={showAddGroup} onOpenChange={setShowAddGroup}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline">
              <Edit2 className="h-4 w-4" />
              Manage Group
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Manage Group Permissions</DialogTitle>
              <DialogDescription>
                Enter the Keycloak group path to manage tool access for
              </DialogDescription>
            </DialogHeader>
            <div className="p-6 pt-0 space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Group Path
                </label>
                <Input
                  placeholder="/developers"
                  value={newGroupPath}
                  onChange={(e) => setNewGroupPath(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddGroup()}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowAddGroup(false)}>
                  Cancel
                </Button>
                <Button onClick={handleAddGroup}>Select</Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-3">
        {groupPermissions.length > 0 ? (
          groupPermissions.map((gp) => (
            <GroupPermissionRow
              key={gp.group}
              group={gp.group}
              tools={tools}
              grantedTools={gp.tools}
              onEdit={setEditingGroup}
              isEditing={editingGroup === gp.group}
              onSave={(toolNames) => bulkSetMutation.mutate({ group: gp.group, toolNames })}
              isSaving={bulkSetMutation.isPending}
            />
          ))
        ) : (
          <EmptyCard message="No groups have access yet — use 'Manage Group' to assign permissions" />
        )}
      </div>

      {editingGroup && !groupPermissions.some((gp) => gp.group === editingGroup) && (
        <GroupPermissionEditor
          group={editingGroup}
          tools={tools}
          grantedTools={[]}
          onSave={(toolNames) => bulkSetMutation.mutate({ group: editingGroup, toolNames })}
          isSaving={bulkSetMutation.isPending}
        />
      )}
    </div>
  )
}

interface GroupPermissionRowProps {
  group: string
  tools: Tool[]
  grantedTools: string[]
  onEdit: (group: string) => void
  isEditing: boolean
  onSave: (toolNames: string[]) => void
  isSaving: boolean
}

const GroupPermissionRow: React.FC<GroupPermissionRowProps> = ({
  group, tools, grantedTools, onEdit, isEditing, onSave, isSaving,
}) => {
  if (isEditing) {
    return (
      <GroupPermissionEditor
        group={group}
        tools={tools}
        grantedTools={grantedTools}
        onSave={onSave}
        isSaving={isSaving}
      />
    )
  }

  return (
    <Card>
      <CardContent className="flex items-center justify-between pt-6">
        <div>
          <code className="font-mono text-sm text-gray-900 dark:text-gray-100">{group}</code>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {grantedTools.length} tool{grantedTools.length !== 1 ? "s" : ""} granted
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => onEdit(group)}>
          <Edit2 className="h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  )
}

interface GroupPermissionEditorProps {
  group: string
  tools: Tool[]
  grantedTools: string[]
  onSave: (toolNames: string[]) => void
  isSaving: boolean
}

const GroupPermissionEditor: React.FC<GroupPermissionEditorProps> = ({
  group, tools, grantedTools, onSave, isSaving,
}) => {
  const [selected, setSelected] = useState<Set<string>>(new Set(grantedTools))

  const toggleAll = () => {
    if (selected.size === tools.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(tools.map((t) => t.name)))
    }
  }

  const toggle = (name: string) => {
    const next = new Set(selected)
    if (next.has(name)) next.delete(name); else next.add(name)
    setSelected(next)
  }

  return (
    <Card className="border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20">
      <CardContent className="pt-6">
        <div className="mb-4 flex items-center justify-between">
          <code className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100">
            {group}
          </code>
          <button
            onClick={toggleAll}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            {selected.size === tools.length ? "Deselect all" : "Select all"}
          </button>
        </div>

        {tools.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            No tools available — refresh the server to discover them
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {tools.map((tool) => (
              <label
                key={tool.name}
                className="flex items-start gap-2.5 cursor-pointer group"
              >
                <input
                  type="checkbox"
                  checked={selected.has(tool.name)}
                  onChange={() => toggle(tool.name)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                />
                <div className="min-w-0">
                  <code className="text-sm font-mono text-gray-900 dark:text-gray-100">
                    {tool.name}
                  </code>
                  {tool.description && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {tool.description}
                    </p>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={isSaving} onClick={() => onSave(Array.from(selected))}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onSave(Array.from(selected))}
            disabled={isSaving}
          >
            {isSaving ? "Saving…" : `Save (${selected.size} tool${selected.size !== 1 ? "s" : ""})`}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Connector tab ───────────────────────────────────────────────────────────

const ConnectorTab: React.FC<{ slug: string }> = ({ slug }) => {
  const { data: config, isLoading, error } = useQuery({
    queryKey: ["connector-config", slug],
    queryFn: () => getConnectorConfig(slug),
  })

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-48 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
        <div className="h-48 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
      </div>
    )
  }

  if (error) {
    return <ErrorCard message="Failed to load connector config" />
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Ready-to-paste MCP client configs. The gateway handles OAuth2 authentication —
        clients just need the URL and OAuth2 settings below.
      </p>
      <div className="grid gap-6 lg:grid-cols-2">
        <ConfigBlock title="Claude Code / Claude Desktop" config={config?.claude} />
        <ConfigBlock title="Generic MCP Client" config={config?.generic} />
      </div>
    </div>
  )
}

interface ConfigBlockProps {
  title: string
  config: unknown
}

const ConfigBlock: React.FC<ConfigBlockProps> = ({ title, config }) => {
  const jsonStr = JSON.stringify(config, null, 2)
  const { copied, copy } = useCopy(jsonStr)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between">
          <span>{title}</span>
          <Button variant="outline" size="sm" onClick={copy}>
            {copied ? (
              <><CheckCircle2 className="h-4 w-4 text-green-500" /> Copied</>
            ) : (
              <><Copy className="h-4 w-4" /> Copy</>
            )}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto rounded-md bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-4 text-xs text-gray-800 dark:text-gray-200 font-mono leading-relaxed">
          {jsonStr}
        </pre>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
          <ExternalLink className="h-3 w-3" />
          Paste into your client's MCP server config
        </p>
      </CardContent>
    </Card>
  )
}

// ── Credentials tab ──────────────────────────────────────────────────────────

interface CredentialsTabProps {
  slug: string
  mcpName: string
  requiresCredential: boolean
  credentialUrl: string | null
}

const CredentialsTab: React.FC<CredentialsTabProps> = ({
  slug, mcpName, requiresCredential, credentialUrl,
}) => {
  const queryClient = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [credentialValue, setCredentialValue] = useState("")
  const [error, setError] = useState("")

  const { data: credStatus, isLoading } = useQuery<CredentialStatus>({
    queryKey: ["my-credential-status", slug],
    queryFn: () => getMyCredentialStatus(slug),
    // Poll every 30s so the UI picks up invalidity without a manual refresh
    refetchInterval: 30_000,
  })

  const hasCredential = credStatus?.exists ?? false
  const isInvalid = credStatus?.is_invalid ?? false

  const setMutation = useMutation({
    mutationFn: (cred: string) => setMyCredential(slug, cred),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-credential-status", slug] })
      setShowForm(false)
      setCredentialValue("")
      setError("")
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to set credential")
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteMyCredential(slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-credential-status", slug] })
      setError("")
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to delete credential")
    },
  })

  const handleSave = () => {
    if (!credentialValue.trim()) {
      setError("Credential cannot be empty")
      return
    }
    setError("")
    setMutation.mutate(credentialValue.trim())
  }

  const handleCancel = () => {
    setShowForm(false)
    setCredentialValue("")
    setError("")
  }

  const handleRemove = () => {
    if (confirm(`Remove credential for ${mcpName}?`)) {
      deleteMutation.mutate()
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-48 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
        <div className="h-32 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
      </div>
    )
  }

  if (!requiresCredential) {
    return (
      <Card className="border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30">
        <CardContent className="flex items-center gap-3 pt-6">
          <ShieldCheck className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
          <p className="text-sm text-blue-700 dark:text-blue-300">
            This MCP server uses a shared service credential. No personal credential required.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Status banner */}
      {hasCredential && isInvalid ? (
        <Card className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
          <CardContent className="pt-6 space-y-2">
            <div className="flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0" />
              <p className="text-sm font-medium text-red-700 dark:text-red-300">
                Credential rejected — likely expired or revoked
              </p>
            </div>
            <p className="text-xs text-red-600 dark:text-red-400 pl-8">
              The upstream returned an auth error when this credential was last used.
              {credStatus?.last_error_at && (
                <> Last rejection: {new Date(credStatus.last_error_at).toLocaleString()}</>
              )}
              {" "}Update your credential below to resume tool calls.
            </p>
          </CardContent>
        </Card>
      ) : hasCredential ? (
        <Card className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
          <CardContent className="flex items-center gap-3 pt-6">
            <ShieldCheck className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0" />
            <div>
              <p className="text-sm text-green-700 dark:text-green-300">Credential configured</p>
              {credStatus?.updated_at && (
                <p className="text-xs text-green-600 dark:text-green-500 mt-0.5">
                  Last updated: {new Date(credStatus.updated_at).toLocaleString()}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950">
          <CardContent className="flex items-center gap-3 pt-6">
            <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 shrink-0" />
            <p className="text-sm text-yellow-700 dark:text-yellow-300">
              No credential set — this server requires your personal credentials to make tool calls
            </p>
          </CardContent>
        </Card>
      )}

      {/* Form or buttons */}
      {showForm ? (
        <Card className="border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20">
          <CardContent className="pt-6 space-y-4">
            {credentialUrl && (
              <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2.5 dark:border-gray-700 dark:bg-gray-800/50">
                <p className="text-sm text-gray-700 dark:text-gray-300 flex-1">
                  Need a new token?{" "}
                  <a
                    href={credentialUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
                  >
                    Generate one here
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </p>
              </div>
            )}
            <div>
              <label className={labelCls}>Personal Access Token</label>
              <Input
                type="password"
                placeholder="glpat-xxxxxxxxxxxxxxxxxxxx"
                value={credentialValue}
                onChange={(e) => setCredentialValue(e.target.value)}
                disabled={setMutation.isPending}
                autoFocus
              />
              <p className="mt-1.5 text-xs text-gray-600 dark:text-gray-400">
                Your PAT is encrypted before storage and is never retrieved in plaintext.
              </p>
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-800 dark:bg-red-950">
                <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0" />
                <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCancel}
                disabled={setMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={setMutation.isPending}
              >
                {setMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-wrap gap-2">
          {hasCredential ? (
            <>
              <Button
                variant={isInvalid ? "default" : "outline"}
                size="sm"
                onClick={() => setShowForm(true)}
                className={isInvalid ? "bg-red-600 hover:bg-red-700 text-white border-0" : ""}
              >
                <KeyRound className="h-4 w-4" />
                {isInvalid ? "Replace expired credential" : "Update credential"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRemove}
                disabled={deleteMutation.isPending}
                className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
              >
                <Trash2 className="h-4 w-4" />
                Remove credential
              </Button>
            </>
          ) : (
            <>
              <Button
                onClick={() => setShowForm(true)}
              >
                <KeyRound className="h-4 w-4" />
                I have a token
              </Button>
              {credentialUrl && (
                <Button
                  variant="outline"
                  onClick={() => {
                    window.open(credentialUrl, "_blank", "noopener,noreferrer")
                    setShowForm(true)
                  }}
                >
                  <ExternalLink className="h-4 w-4" />
                  Generate new token
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {error && !showForm && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-800 dark:bg-red-950">
          <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0" />
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
        </div>
      )}
    </div>
  )
}
