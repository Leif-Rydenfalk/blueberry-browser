import React, { useEffect, useState } from "react";
import { LogIn, QrCode, SkipForward, X } from "lucide-react";
import { cn } from "@common/lib/utils";
import type {
  LoginDecision,
  LoginRequiredRequest,
} from "../contexts/AgentContext";

interface LoginSheetProps {
  readonly request: LoginRequiredRequest;
  readonly onResolve: (
    id: string,
    decision: LoginDecision,
  ) => Promise<void> | void;
}

const formatWait = (ms: number): string => {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
};

export const LoginSheet: React.FC<LoginSheetProps> = ({
  request,
  onResolve,
}) => {
  const [submitting, setSubmitting] = useState<LoginDecision | null>(null);
  const [elapsedMs, setElapsedMs] = useState(Date.now() - request.createdAt);

  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - request.createdAt);
    }, 1000);
    return () => window.clearInterval(id);
  }, [request.createdAt]);

  const decide = async (decision: LoginDecision): Promise<void> => {
    setSubmitting(decision);
    try {
      await onResolve(request.id, decision);
    } finally {
      setSubmitting(null);
    }
  };

  const Icon = request.qrLogin ? QrCode : LogIn;

  return (
    <div
      className={cn(
        "absolute inset-0 z-40 flex items-end justify-center",
        "bg-black/50 backdrop-blur-sm",
      )}
      role="dialog"
      aria-modal="true"
      aria-label={`Sign in to ${request.app}`}
    >
      <div
        className={cn(
          "w-full mx-3 mb-3 rounded-2xl border border-primary/30",
          "bg-background shadow-lg p-4 space-y-3.5 max-h-[88%] overflow-y-auto",
        )}
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "shrink-0 size-9 rounded-xl flex items-center justify-center",
              "bg-primary/10 text-primary",
            )}
          >
            <Icon className="size-5" />
          </div>
          <div className="space-y-0.5 min-w-0 flex-1">
            <h3 className="text-sm font-semibold leading-tight">
              Sign in to {request.app}
            </h3>
            <p className="text-xs text-muted-foreground leading-snug">
              The agent is paused until you sign in. It will continue as soon as
              you press <span className="text-foreground">I&apos;m signed in</span>.
            </p>
          </div>
          <div className="text-[10px] text-muted-foreground/70 shrink-0 tabular-nums pt-1">
            waiting {formatWait(elapsedMs)}
          </div>
        </div>

        <div className="rounded-xl border border-border/60 bg-secondary/30 p-3 space-y-2">
          <div className="text-xs leading-relaxed text-foreground whitespace-pre-wrap break-words">
            {request.instructions}
          </div>
          {request.url && (
            <div className="text-[11px] text-muted-foreground break-all">
              <span className="text-muted-foreground/70">page:</span>{" "}
              <span className="font-mono">{request.url}</span>
            </div>
          )}
          {request.qrLogin && (
            <div className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 text-[10px] font-medium">
              <QrCode className="size-2.5" /> QR-code login
            </div>
          )}
        </div>

        {request.screenshot && (
          <div className="rounded-xl border border-border/50 overflow-hidden">
            <img
              src={request.screenshot}
              alt="Login page"
              className="w-full block"
            />
          </div>
        )}

        <button
          onClick={() => decide("signed-in")}
          disabled={!!submitting}
          className={cn(
            "w-full flex items-center justify-center gap-2 px-3 py-2.5",
            "rounded-xl text-sm font-medium",
            "bg-primary text-primary-foreground",
            "hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed",
            "transition-opacity cursor-pointer",
          )}
        >
          <LogIn className="size-4" />
          I&apos;m signed in — continue
        </button>

        <div className="grid grid-cols-2 gap-2">
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
            Skip this app
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
