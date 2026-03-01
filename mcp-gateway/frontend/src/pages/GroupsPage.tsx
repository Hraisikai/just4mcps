import React, { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { listGroups, listGroupPermissions, type Group } from "../lib/api"
import { Card, CardContent } from "../components/ui/card"
import { AlertCircle, ChevronDown, ChevronRight } from "lucide-react"

export const GroupsPage: React.FC = () => {
  const groupsQuery = useQuery({
    queryKey: ["groups"],
    queryFn: listGroups,
  })

  if (groupsQuery.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
          ))}
        </div>
      </div>
    )
  }

  if (groupsQuery.error) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Card className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
          <CardContent className="flex items-center gap-3 pt-6">
            <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0" />
            <p className="text-sm text-red-700 dark:text-red-300">Failed to load groups</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const groups = groupsQuery.data || []

  return (
    <div className="space-y-6">
      <PageHeader />

      {groups.length > 0 ? (
        <div className="space-y-3">
          {groups.map((group) => (
            <GroupRow key={group.path} group={group} />
          ))}
        </div>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex items-center justify-center py-12">
            <p className="text-gray-500 dark:text-gray-400">No groups found</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

const PageHeader: React.FC = () => (
  <div>
    <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Groups</h1>
    <p className="mt-1 text-gray-500 dark:text-gray-400">
      Keycloak group permissions across MCP servers
    </p>
  </div>
)

interface GroupRowProps {
  group: Group
}

const GroupRow: React.FC<GroupRowProps> = ({ group }) => {
  const [isExpanded, setIsExpanded] = useState(false)

  const { data: permissions, isLoading } = useQuery({
    queryKey: ["group-permissions", group.path],
    queryFn: () => listGroupPermissions(group.path),
    enabled: isExpanded,
  })

  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            {isExpanded ? (
              <ChevronDown className="h-4 w-4 text-gray-500 dark:text-gray-400 shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-gray-500 dark:text-gray-400 shrink-0" />
            )}
            <code className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100">
              {group.path}
            </code>
          </div>
        </button>

        {isExpanded && (
          <div className="mt-4 border-t border-gray-200 dark:border-gray-700 pt-4">
            {isLoading ? (
              <div className="animate-pulse space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-8 rounded bg-gray-200 dark:bg-gray-700" />
                ))}
              </div>
            ) : permissions && permissions.permissions.length > 0 ? (
              <div className="space-y-4">
                {permissions.permissions.map((perm) => (
                  <div key={perm.mcp_slug}>
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
                      {perm.mcp_slug}
                    </p>
                    {perm.tools.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {perm.tools.map((tool) => (
                          <span
                            key={tool}
                            className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 text-xs font-mono text-gray-700 dark:text-gray-300"
                          >
                            {tool}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-gray-400 dark:text-gray-500 italic">
                        No tools granted
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No tool permissions assigned to this group
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
