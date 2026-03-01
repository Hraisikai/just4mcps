import React from "react"
import { cn } from "../lib/utils"

type Status = "connected" | "connecting" | "degraded" | "disconnected" | "unknown"

interface StatusDotProps {
  status: Status
  className?: string
  showLabel?: boolean
}

const statusColors: Record<Status, string> = {
  connected: "bg-green-500",
  connecting: "bg-blue-500",
  degraded: "bg-yellow-500",
  disconnected: "bg-red-500",
  unknown: "bg-gray-400",
}

const statusLabels: Record<Status, string> = {
  connected: "Connected",
  connecting: "Connecting",
  degraded: "Degraded",
  disconnected: "Disconnected",
  unknown: "Unknown",
}

export const StatusDot: React.FC<StatusDotProps> = ({
  status,
  className,
  showLabel = true,
}) => {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        className={cn(
          "h-2 w-2 rounded-full",
          statusColors[status]
        )}
      />
      {showLabel && (
        <span className="text-sm text-gray-700 dark:text-gray-300">{statusLabels[status]}</span>
      )}
    </div>
  )
}
