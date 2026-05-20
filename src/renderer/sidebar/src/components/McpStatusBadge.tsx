import React, { useEffect, useState } from "react";
import { Network, CircleDashed, AlertCircle } from "lucide-react";
import { cn } from "@common/lib/utils";

// Small status indicator shown above the sidebar tabs. Tells the user that
// Blueberry is reachable by other agents (Hermes, Claude, n8n, …) and shows
// the latest inbound delegation request. See MCP_DELEGATION.md.

const PULSE_DURATION_MS = 2400;

interface ActiveRequest {
  readonly id: string;
  readonly task: string;
}

export const McpStatusBadge: React.FC = () => {
  const [status, setStatus] = useState<{
    enabled: boolean;
    listening: boolean;
    url: string;
    totalRequests: number;
    lastError: string | null;
  } | null>(null);
  const [active, setActive] = useState<ActiveRequest | null>(null);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    const api = window.sidebarAPI;
    if (!api) return;

    void api.getMcpStatus().then((next) => {
      if (next) setStatus(next);
    });

    api.onMcpStatusChanged((next) => setStatus(next));

    api.onMcpRequestReceived((event) => {
      setActive({ id: event.id, task: event.task });
      setPulse(true);
      window.setTimeout(() => setPulse(false), PULSE_DURATION_MS);
    });

    api.onMcpRequestCompleted((event) => {
      setActive((curr) => (curr && curr.id === event.id ? null : curr));
    });

    return () => api.removeMcpListeners();
  }, []);

  if (!status?.enabled) return null;

  const hasError = !!status.lastError;
  const listening = status.listening && !hasError;
  const tooltip = hasError
    ? `MCP error: ${status.lastError}`
    : listening
      ? `Reachable at ${status.url} — ${status.totalRequests} delegation${status.totalRequests === 1 ? "" : "s"} served`
      : "MCP server starting…";

  return (
    <div
      title={tooltip}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5",
        "border-b border-border/40 bg-muted/30",
        "text-[11px] text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "flex items-center justify-center w-5 h-5 rounded-full",
          listening
            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            : hasError
              ? "bg-red-500/15 text-red-600 dark:text-red-400"
              : "bg-muted text-muted-foreground",
          pulse && "animate-pulse",
        )}
      >
        {hasError ? (
          <AlertCircle className="w-3 h-3" />
        ) : listening ? (
          <Network className="w-3 h-3" />
        ) : (
          <CircleDashed className="w-3 h-3" />
        )}
      </span>
      <span className="flex-1 min-w-0 truncate">
        {hasError ? (
          <>MCP unavailable</>
        ) : active ? (
          <>
            <span className="text-foreground/90 font-medium">Delegated:</span>{" "}
            {active.task}
          </>
        ) : listening ? (
          <>
            MCP on{" "}
            <span className="font-mono text-foreground/80">
              :{status.url.split(":").pop()}
            </span>{" "}
            · {status.totalRequests} call{status.totalRequests === 1 ? "" : "s"}
          </>
        ) : (
          <>MCP starting…</>
        )}
      </span>
    </div>
  );
};
