import React, { useState } from "react";
import { Code2, Pencil, Check, X, CheckCheck } from "lucide-react";
import { cn } from "@common/lib/utils";
import type { ScriptReviewRequest } from "../contexts/AgentContext";

interface ScriptReviewSheetProps {
  readonly request: ScriptReviewRequest;
  readonly onResolve: (
    id: string,
    decision: "approve" | "reject",
    approvedScript?: string,
  ) => Promise<void> | void;
}

export const ScriptReviewSheet: React.FC<ScriptReviewSheetProps> = ({
  request,
  onResolve,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editedScript, setEditedScript] = useState(request.script);
  const [submitting, setSubmitting] = useState<
    "approve" | "reject" | null
  >(null);

  const decide = async (
    decision: "approve" | "reject",
  ): Promise<void> => {
    setSubmitting(decision);
    try {
      if (decision === "approve") {
        await onResolve(request.id, "approve", editedScript);
      } else {
        await onResolve(request.id, "reject");
      }
    } finally {
      setSubmitting(null);
    }
  };

  const isModified = editedScript !== request.script;

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
          "bg-background shadow-lg p-4 space-y-3 max-h-[90%] overflow-y-auto",
        )}
      >
        {/* Header */}
        <div className="flex items-start gap-2.5">
          <Code2 className="size-4 text-primary shrink-0 mt-0.5" />
          <div className="space-y-1 min-w-0 flex-1">
            <h3 className="text-sm font-semibold leading-tight">
              Script review
            </h3>
            <p className="text-xs text-muted-foreground leading-snug">
              Review this script before it runs on the page.
            </p>
          </div>
          {request.name && (
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                "bg-primary/10 text-primary border border-primary/20",
              )}
            >
              {request.name}
            </span>
          )}
        </div>

        {/* Description */}
        <div className="rounded-xl border border-border/50 p-3 space-y-1">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
            What this script does
          </p>
          <p className="text-xs leading-relaxed">{request.description}</p>
        </div>

        {/* Script block */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              Script
              {isModified && (
                <span className="ml-1.5 text-amber-500">(edited)</span>
              )}
            </p>
            <button
              onClick={() => setIsEditing((v) => !v)}
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium",
                "transition-colors cursor-pointer",
                isEditing
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              {isEditing ? (
                <>
                  <CheckCheck className="size-3" />
                  Done editing
                </>
              ) : (
                <>
                  <Pencil className="size-3" />
                  Edit
                </>
              )}
            </button>
          </div>

          {isEditing ? (
            <textarea
              value={editedScript}
              onChange={(e) => setEditedScript(e.target.value)}
              rows={10}
              spellCheck={false}
              className={cn(
                "w-full rounded-xl border border-border/50 p-3",
                "bg-secondary/40 font-mono text-[11px] leading-relaxed",
                "outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20",
                "resize-none",
              )}
            />
          ) : (
            <div
              className={cn(
                "rounded-xl border border-border/50 p-3 overflow-auto max-h-52",
                "bg-secondary/40",
              )}
            >
              <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
                {editedScript}
              </pre>
            </div>
          )}
        </div>

        {/* Screenshot */}
        {request.screenshot && (
          <div className="rounded-xl border border-border/50 overflow-hidden">
            <img
              src={request.screenshot}
              alt="Current page"
              className="w-full block"
            />
          </div>
        )}

        {/* Actions */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            onClick={() => decide("approve")}
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
            {isModified ? "Run edited script" : "Run script"}
          </button>
          <button
            onClick={() => decide("reject")}
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
            Reject
          </button>
        </div>
      </div>
    </div>
  );
};
