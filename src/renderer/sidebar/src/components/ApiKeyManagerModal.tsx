import React, { useCallback, useEffect, useState } from "react";
import { X, Key, Eye, EyeOff, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { cn } from "@common/lib/utils";
import { Button } from "@common/components/Button";

// Modal for managing per-provider API keys. Reads status on mount, lets the
// user paste / test / save / clear keys, and persists via SettingsStore in the
// main process. After every save we call onChanged() so the parent panel can
// refresh its model picker — a new Gemini key, for instance, should make
// Gemini models appear in the dropdown immediately.

type Provider = "openai" | "anthropic" | "google";

interface ApiKeyStatus {
  readonly provider: Provider;
  readonly configured: boolean;
  readonly source: "ui" | "env" | "none";
  readonly preview: string | null;
  readonly updatedAt: number | null;
}

interface ApiKeyManagerModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}

interface ProviderMeta {
  readonly id: Provider;
  readonly label: string;
  readonly placeholder: string;
  readonly help: string;
  readonly signupUrl: string;
}

const PROVIDERS: ReadonlyArray<ProviderMeta> = [
  {
    id: "openai",
    label: "OpenAI",
    placeholder: "sk-…",
    help: "Get a key at platform.openai.com/api-keys.",
    signupUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    placeholder: "sk-ant-…",
    help: "Get a key at console.anthropic.com/settings/keys.",
    signupUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "google",
    label: "Google (Gemini)",
    placeholder: "AIza…",
    help: "Get a key at aistudio.google.com/app/apikey.",
    signupUrl: "https://aistudio.google.com/app/apikey",
  },
];

export const ApiKeyManagerModal: React.FC<ApiKeyManagerModalProps> = ({
  open,
  onClose,
  onChanged,
}) => {
  const [statuses, setStatuses] = useState<ReadonlyArray<ApiKeyStatus>>([]);
  const [loading, setLoading] = useState(true);

  const loadStatuses = useCallback(async () => {
    setLoading(true);
    try {
      const next = await window.sidebarAPI.getApiKeyStatuses();
      setStatuses(next);
    } catch (error) {
      console.error("Failed to load API key statuses:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadStatuses();
  }, [open, loadStatuses]);

  if (!open) return null;

  const statusFor = (provider: Provider): ApiKeyStatus | undefined =>
    statuses.find((s) => s.provider === provider);

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center",
        "bg-background/80 backdrop-blur-sm",
      )}
      onClick={onClose}
    >
      <div
        className={cn(
          "relative w-full max-w-md mx-4",
          "bg-background border border-border rounded-xl shadow-xl",
          "max-h-[90vh] overflow-y-auto",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
          <div className="flex items-center gap-2">
            <Key className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">API keys</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted/60"
            aria-label="Close"
          >
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>

        <div className="px-4 py-3 text-[11px] text-muted-foreground border-b border-border/40">
          Keys are encrypted with your OS keychain and stored locally. UI-saved
          keys override <code className="font-mono">.env</code> values.
        </div>

        <div className="p-4 space-y-4">
          {loading && statuses.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin mr-2" />
              Loading…
            </div>
          ) : (
            PROVIDERS.map((meta) => (
              <ProviderRow
                key={meta.id}
                meta={meta}
                status={statusFor(meta.id)}
                onSaved={async () => {
                  await loadStatuses();
                  onChanged();
                }}
                onCleared={async () => {
                  await loadStatuses();
                  onChanged();
                }}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
};

interface ProviderRowProps {
  readonly meta: ProviderMeta;
  readonly status: ApiKeyStatus | undefined;
  readonly onSaved: () => Promise<void>;
  readonly onCleared: () => Promise<void>;
}

const ProviderRow: React.FC<ProviderRowProps> = ({
  meta,
  status,
  onSaved,
  onCleared,
}) => {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<"none" | "save" | "test" | "clear">("none");
  const [feedback, setFeedback] = useState<{
    type: "ok" | "error";
    text: string;
  } | null>(null);

  const handleTest = async (): Promise<void> => {
    if (!value.trim()) {
      setFeedback({ type: "error", text: "Paste a key first" });
      return;
    }
    setBusy("test");
    setFeedback(null);
    try {
      const result = await window.sidebarAPI.testApiKey(meta.id, value);
      if (result.ok) {
        setFeedback({
          type: "ok",
          text: `Verified · ${result.modelCount ?? 0} models available`,
        });
      } else {
        setFeedback({
          type: "error",
          text: result.error || "Key did not validate",
        });
      }
    } finally {
      setBusy("none");
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!value.trim()) return;
    setBusy("save");
    setFeedback(null);
    try {
      await window.sidebarAPI.setApiKey(meta.id, value);
      setValue("");
      setFeedback({ type: "ok", text: "Saved" });
      await onSaved();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save";
      setFeedback({ type: "error", text: message });
    } finally {
      setBusy("none");
    }
  };

  const handleClear = async (): Promise<void> => {
    setBusy("clear");
    setFeedback(null);
    try {
      await window.sidebarAPI.clearApiKey(meta.id);
      setFeedback({ type: "ok", text: "Cleared" });
      await onCleared();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to clear";
      setFeedback({ type: "error", text: message });
    } finally {
      setBusy("none");
    }
  };

  const configured = status?.configured ?? false;
  const sourceLabel =
    status?.source === "ui"
      ? "saved here"
      : status?.source === "env"
        ? "from .env"
        : "not set";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate">{meta.label}</span>
          <span
            className={cn(
              "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded",
              configured
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-muted text-muted-foreground",
            )}
          >
            {configured ? sourceLabel : "not set"}
          </span>
        </div>
        {configured && status?.preview && (
          <span className="text-[10px] font-mono text-muted-foreground shrink-0">
            {status.preview}
          </span>
        )}
      </div>

      <div className="flex items-stretch gap-1.5">
        <div className="relative flex-1 min-w-0">
          <input
            type={reveal ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={meta.placeholder}
            spellCheck={false}
            autoComplete="off"
            className={cn(
              "w-full px-2.5 py-1.5 pr-8 rounded-md",
              "text-xs font-mono",
              "bg-background border border-border/60",
              "focus:outline-none focus:ring-1 focus:ring-primary/40",
            )}
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
            tabIndex={-1}
            aria-label={reveal ? "Hide key" : "Show key"}
          >
            {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleTest}
          disabled={busy !== "none"}
          className="h-auto px-2 text-xs"
        >
          {busy === "test" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            "Test"
          )}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={handleSave}
          disabled={busy !== "none" || !value.trim()}
          className="h-auto px-2 text-xs"
        >
          {busy === "save" ? <Loader2 className="size-3 animate-spin" /> : "Save"}
        </Button>
      </div>

      <div className="flex items-center justify-between">
        <a
          href={meta.signupUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-muted-foreground hover:text-foreground underline decoration-dotted"
        >
          {meta.help}
        </a>
        {configured && status?.source === "ui" && (
          <button
            onClick={handleClear}
            disabled={busy !== "none"}
            className="text-[10px] text-muted-foreground hover:text-destructive"
          >
            {busy === "clear" ? "…" : "Remove"}
          </button>
        )}
      </div>

      {feedback && (
        <div
          className={cn(
            "flex items-center gap-1 text-[11px]",
            feedback.type === "ok"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-destructive",
          )}
        >
          {feedback.type === "ok" ? (
            <CheckCircle2 className="size-3" />
          ) : (
            <AlertCircle className="size-3" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}
    </div>
  );
};
