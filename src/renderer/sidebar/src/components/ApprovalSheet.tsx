import React, { useState } from "react";
import { AlertTriangle, Check, CheckCheck, SkipForward, X } from "lucide-react";
import { cn } from "@common/lib/utils";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "../contexts/AgentContext";

interface ApprovalSheetProps {
  readonly request: ApprovalRequest;
  readonly onResolve: (
    id: string,
    decision: ApprovalDecision,
  ) => Promise<void> | void;
}

const summarizeAction = (action: ApprovalRequest["action"]): string => {
  const params = action.params || {};
  switch (action.type) {
    case "click": {
      const sel = params.selector as string | undefined;
      const x = params.x as number | undefined;
      const y = params.y as number | undefined;
      if (sel) return `Click \`${sel}\``;
      if (x !== undefined && y !== undefined) return `Click at (${x}, ${y})`;
      return "Click";
    }
    case "type": {
      const text = params.text as string | undefined;
      const sel = params.selector as string | undefined;
      const snippet = text
        ? `"${text.length > 80 ? text.slice(0, 80) + "…" : text}"`
        : "(no text)";
      return sel ? `Type ${snippet} into \`${sel}\`` : `Type ${snippet}`;
    }
    case "key":
      return `Press \`${(params.key as string) || "key"}\``;
    case "waitForApproval":
      return (params.reason as string) || "Pause for approval";
    default:
      return action.type;
  }
};

export const ApprovalSheet: React.FC<ApprovalSheetProps> = ({
  request,
  onResolve,
}) => {
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);

  const decide = async (decision: ApprovalDecision): Promise<void> => {
    setSubmitting(decision);
    try {
      await onResolve(request.id, decision);
    } finally {
      setSubmitting(null);
    }
  };

  const summary = summarizeAction(request.action);

  return (
    <div
      className={cn(
        "absolute inset-0 z-30 flex items-end justify-center",
        "bg-black/40 backdrop-blur-sm",
      )}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={cn(
          "w-full mx-3 mb-3 rounded-2xl border border-border",
          "bg-background shadow-lg p-4 space-y-3 max-h-[85%] overflow-y-auto",
        )}
      >
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="size-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="space-y-1 min-w-0 flex-1">
            <h3 className="text-sm font-semibold leading-tight">
              Approve this action?
            </h3>
            <p className="text-xs text-muted-foreground leading-snug">
              The agent is about to perform a potentially irreversible step.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-border/50 p-3 space-y-2">
          <div className="text-xs font-medium break-words">{summary}</div>
          {request.elementLabel && (
            <div className="text-[11px] text-muted-foreground">
              Target reads:{" "}
              <span className="text-foreground">
                &quot;{request.elementLabel}&quot;
              </span>
            </div>
          )}
          {request.action.reasoning && (
            <div className="text-[11px] text-muted-foreground italic">
              {request.action.reasoning}
            </div>
          )}
          {request.matchedKeyword && (
            <div className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20 px-2 py-0.5 text-[10px] font-medium">
              keyword: {request.matchedKeyword}
            </div>
          )}
        </div>

        {request.screenshot && (
          <div className="rounded-xl border border-border/50 overflow-hidden">
            <img
              src={request.screenshot}
              alt="Current page"
              className="w-full block"
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            onClick={() => decide("approve-once")}
            disabled={!!submitting}
            className={cn(
              "flex items-center justify-center gap-1.5 px-3 py-2",
              "rounded-xl text-xs font-medium",
              "bg-primary text-primary-foreground",
              "hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed",
              "transition-opacity cursor-pointer",
            )}
          >
            <Check className="size-3.5" />
            Approve once
          </button>
          <button
            onClick={() => decide("approve-all")}
            disabled={!!submitting}
            className={cn(
              "flex items-center justify-center gap-1.5 px-3 py-2",
              "rounded-xl text-xs font-medium",
              "bg-primary/10 text-primary hover:bg-primary/20",
              "border border-primary/20",
              "disabled:opacity-40 disabled:cursor-not-allowed",
              "transition-colors cursor-pointer",
            )}
          >
            <CheckCheck className="size-3.5" />
            Approve all in run
          </button>
          <button
            onClick={() => decide("skip")}
            disabled={!!submitting}
            className={cn(
              "flex items-center justify-center gap-1.5 px-3 py-2",
              "rounded-xl text-xs font-medium",
              "hover:bg-muted text-muted-foreground hover:text-foreground",
              "border border-border/60",
              "disabled:opacity-40 disabled:cursor-not-allowed",
              "transition-colors cursor-pointer",
            )}
          >
            <SkipForward className="size-3.5" />
            Skip
          </button>
          <button
            onClick={() => decide("stop")}
            disabled={!!submitting}
            className={cn(
              "flex items-center justify-center gap-1.5 px-3 py-2",
              "rounded-xl text-xs font-medium",
              "bg-red-500/10 text-red-500 hover:bg-red-500/20",
              "border border-red-500/20",
              "disabled:opacity-40 disabled:cursor-not-allowed",
              "transition-colors cursor-pointer",
            )}
          >
            <X className="size-3.5" />
            Stop run
          </button>
        </div>
      </div>
    </div>
  );
};
