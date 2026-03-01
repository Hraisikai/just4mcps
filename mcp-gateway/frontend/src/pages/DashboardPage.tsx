import React from "react"
import { useQuery } from "@tanstack/react-query"
import { getGatewayStatus } from "../lib/api"
import { Card, CardContent } from "../components/ui/card"
import { StatusDot } from "../components/StatusDot"
import { AlertCircle, Database, Activity } from "lucide-react"

export const DashboardPage: React.FC = () => {
  const { data: status, isLoading, error } = useQuery({
    queryKey: ["gatewayStatus"],
    queryFn: getGatewayStatus,
    refetchInterval: 10_000,
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <div className="grid gap-6 md:grid-cols-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-800" />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Card className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
          <CardContent className="flex items-center gap-3 pt-6">
            <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0" />
            <p className="text-sm text-red-700 dark:text-red-300">
              Failed to load gateway status:{" "}
              {error instanceof Error ? error.message : "Unknown error"}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <PageHeader />

      {/* Stats */}
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                  MCP Servers
                </p>
                <p className="mt-2 text-4xl font-bold text-gray-900 dark:text-gray-100">
                  {status?.mcp_count ?? 0}
                </p>
              </div>
              <Database className="h-10 w-10 text-blue-200 dark:text-blue-800" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                  Gateway Status
                </p>
                <p className="mt-2 text-xl font-semibold text-gray-900 dark:text-gray-100">
                  {status?.status ?? "Unknown"}
                </p>
              </div>
              <Activity className="h-10 w-10 text-green-200 dark:text-green-800" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Upstreams */}
      <div>
        <h2 className="mb-4 text-xl font-semibold text-gray-900 dark:text-gray-100">
          Upstream Connections
        </h2>
        <div className="space-y-3">
          {status?.upstreams && status.upstreams.length > 0 ? (
            status.upstreams.map((upstream) => (
              <Card key={upstream.name}>
                <CardContent className="flex items-center justify-between pt-5 pb-5">
                  <div className="min-w-0">
                    <h3 className="font-medium text-gray-900 dark:text-gray-100">
                      {upstream.name}
                    </h3>
                    <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400 font-mono truncate">
                      {upstream.url}
                    </p>
                  </div>
                  <div className="ml-4 flex flex-col items-end gap-1 shrink-0">
                    <StatusDot status={upstream.status} />
                    {upstream.failure_count > 0 && (
                      <p className="text-xs text-red-600 dark:text-red-400">
                        {upstream.failure_count} failure{upstream.failure_count !== 1 ? "s" : ""}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <Card className="border-dashed">
              <CardContent className="flex items-center justify-center py-12">
                <p className="text-gray-500 dark:text-gray-400">No upstreams configured</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

const PageHeader: React.FC = () => (
  <div>
    <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Dashboard</h1>
    <p className="mt-1 text-gray-500 dark:text-gray-400">
      Gateway health and upstream status
    </p>
  </div>
)
