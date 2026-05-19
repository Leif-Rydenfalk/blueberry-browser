import React, { useState, useRef, useEffect, useCallback } from "react";
import { useWorkflow } from "../contexts/WorkflowContext";
import { cn } from "@common/lib/utils";
import {
  Circle,
  Play,
  Trash2,
  Pencil,
  Check,
  X,
  Navigation,
  MessageSquare,
  ChevronRight,
  ChevronLeft,
  Loader2,
  Database,
  Upload,
  Layers,
} from "lucide-react";

interface WorkflowDataset {
  columns: ReadonlyArray<string>;
  rows: ReadonlyArray<Record<string, string>>;
  source?: string;
}

// Minimal RFC-4180-ish parser: quoted fields, escaped quotes (""), embedded newlines.
function parseCsvText(text: string, source?: string): WorkflowDataset {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      current.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      current.push(field);
      rows.push(current);
      current = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    rows.push(current);
  }
  if (rows.length === 0) return { columns: [], rows: [], source };
  const header = rows[0].map((c) => c.trim()).filter((c) => c.length > 0);
  const data: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((v) => v.trim() === "")) continue;
    const obj: Record<string, string> = {};
    header.forEach((col, idx) => {
      obj[col] = (row[idx] ?? "").trim();
    });
    data.push(obj);
  }
  return { columns: header, rows: data, source };
}

const formatDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
};

const formatUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== "/" ? u.pathname.slice(0, 30) : "");
  } catch {
    return url.slice(0, 40);
  }
};

const formatTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// --- Dataset uploader ---

const DatasetUploader: React.FC<{
  onParsed: (dataset: WorkflowDataset) => void;
  onCancel: () => void;
}> = ({ onParsed, onCancel }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      try {
        const content = await file.text();
        const parsed = parseCsvText(content, file.name);
        if (parsed.columns.length === 0 || parsed.rows.length === 0) {
          setError("Could not parse any rows from this CSV.");
          return;
        }
        onParsed(parsed);
      } catch {
        setError("Failed to read file.");
      }
    },
    [onParsed],
  );

  const handlePaste = useCallback(() => {
    const parsed = parseCsvText(text, "pasted");
    if (parsed.columns.length === 0 || parsed.rows.length === 0) {
      setError("Could not parse any rows. Make sure the first row is headers.");
      return;
    }
    onParsed(parsed);
  }, [text, onParsed]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onCancel}
      />
      <div
        className={cn(
          "relative w-full rounded-xl p-4 space-y-3",
          "bg-background border border-border shadow-xl",
        )}
      >
        <div className="flex items-center gap-2">
          <Database className="size-4 text-primary" />
          <div className="text-sm font-semibold">Attach a dataset</div>
        </div>
        <p className="text-xs text-muted-foreground">
          First row is treated as column headers. Each subsequent row drives one
          run of the workflow with its values substituted into bound steps.
        </p>

        <div className="space-y-2">
          <button
            onClick={() => fileRef.current?.click()}
            className={cn(
              "flex items-center justify-center gap-2 w-full py-2",
              "rounded-xl text-sm font-medium border border-border/60",
              "hover:bg-secondary/50 transition-colors",
            )}
          >
            <Upload className="size-3.5" />
            Pick a CSV file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            <div className="flex-1 border-t border-border/40" />
            or paste
            <div className="flex-1 border-t border-border/40" />
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "name,email\nAcme,founder@acme.com\nGlobex,a@globex.io"
            }
            rows={5}
            className={cn(
              "w-full text-xs font-mono rounded-xl border border-border/50",
              "bg-background px-3 py-2 outline-none focus:border-primary/40 resize-none",
            )}
          />
        </div>

        {error && <div className="text-xs text-red-500">{error}</div>}

        <div className="flex gap-2">
          <button
            onClick={handlePaste}
            disabled={text.trim().length === 0}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 py-2",
              "rounded-lg text-sm font-medium",
              "bg-primary text-primary-foreground hover:opacity-90",
              "disabled:opacity-40 disabled:cursor-not-allowed transition-opacity",
            )}
          >
            Use pasted CSV
          </button>
          <button
            onClick={onCancel}
            className={cn(
              "px-4 py-2 rounded-lg text-sm",
              "text-muted-foreground hover:bg-secondary transition-colors",
            )}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

// --- Recording bar ---

const RecordingBar: React.FC = () => {
  const {
    recording,
    stopRecording,
    cancelRecording,
    addAnnotation,
    recordingDataset,
    setRecordingDataset,
  } = useWorkflow();
  const [uploading, setUploading] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [annotation, setAnnotation] = useState("");
  const [saving, setSaving] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const elapsed = recording.startedAt
    ? Math.round((Date.now() - recording.startedAt) / 1000)
    : 0;

  const handleSave = async (): Promise<void> => {
    const name =
      saveName.trim() || `Workflow ${new Date().toLocaleDateString()}`;
    setSaving(true);
    await stopRecording(name);
    setSaveName("");
    setSaving(false);
  };

  const handleAnnotate = async (): Promise<void> => {
    if (!annotation.trim()) return;
    await addAnnotation(annotation.trim());
    setAnnotation("");
    setAnnotating(false);
  };

  return (
    <div className="mx-3 mb-2 rounded-xl border border-red-500/20 bg-red-500/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="size-1.5 rounded-full bg-red-500 animate-pulse shrink-0" />
        <span className="text-xs font-medium text-red-500">Recording</span>
        <span className="text-xs text-muted-foreground ml-auto tabular-nums">
          {recording.stepCount} steps · {elapsed}s
        </span>
      </div>

      <div className="flex items-center gap-1.5 text-xs">
        {recordingDataset ? (
          <>
            <Database className="size-3 text-primary" />
            <span className="text-foreground">
              {recordingDataset.rows.length} rows ·{" "}
              {recordingDataset.columns.length} cols
            </span>
            <span className="text-muted-foreground truncate">
              ({recordingDataset.columns.join(", ")})
            </span>
            <button
              onClick={() => setRecordingDataset(null)}
              className="ml-auto text-muted-foreground hover:text-red-500 transition-colors"
            >
              clear
            </button>
          </>
        ) : (
          <button
            onClick={() => setUploading(true)}
            className={cn(
              "flex items-center gap-1.5 text-muted-foreground",
              "hover:text-foreground transition-colors",
            )}
          >
            <Database className="size-3" />
            Attach data (CSV)
            <span className="text-[10px] opacity-60">
              → right-click inputs to bind
            </span>
          </button>
        )}
      </div>

      {uploading && (
        <DatasetUploader
          onParsed={(d) => {
            setRecordingDataset(d);
            setUploading(false);
          }}
          onCancel={() => setUploading(false)}
        />
      )}

      {recording.currentUrl && (
        <div className="text-xs text-muted-foreground truncate">
          <Navigation className="size-3 inline mr-1 opacity-60" />
          {formatUrl(recording.currentUrl)}
        </div>
      )}

      {annotating ? (
        <div className="flex gap-1.5">
          <input
            ref={inputRef}
            value={annotation}
            onChange={(e) => setAnnotation(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAnnotate();
              if (e.key === "Escape") setAnnotating(false);
            }}
            placeholder="Note what you're doing..."
            className="flex-1 text-xs rounded-lg bg-background border border-border/50 px-2 py-1.5 outline-none focus:border-primary/40"
            autoFocus
          />
          <button
            onClick={handleAnnotate}
            className="p-1.5 rounded-lg hover:bg-primary/10 text-primary"
          >
            <Check className="size-3.5" />
          </button>
          <button
            onClick={() => setAnnotating(false)}
            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setAnnotating(true)}
          className={cn(
            "flex items-center gap-1.5 w-full px-2.5 py-1.5 rounded-lg text-xs",
            "border border-border/40 hover:bg-background/60",
            "text-muted-foreground hover:text-foreground transition-colors",
          )}
        >
          <MessageSquare className="size-3" />
          Add note for this step...
        </button>
      )}

      <div className="flex gap-1.5">
        <div className="flex-1">
          <input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
            }}
            placeholder="Workflow name..."
            className="w-full text-xs rounded-lg bg-background border border-border/50 px-2 py-1.5 outline-none focus:border-primary/40"
          />
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className={cn(
            "flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium",
            "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity",
          )}
        >
          {saving ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Check className="size-3" />
          )}
          Save
        </button>
        <button
          onClick={cancelRecording}
          className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-border/50 hover:bg-muted text-muted-foreground transition-colors"
        >
          Discard
        </button>
      </div>
    </div>
  );
};

// --- Workflow card ---

interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  duration: number;
  stepCount: number;
  startUrl: string;
  endUrl: string;
  datasetRowCount?: number;
  datasetColumns?: ReadonlyArray<string>;
}

const WorkflowCard: React.FC<{
  workflow: WorkflowSummary;
  onExecute: () => void;
  onOpen: () => void;
}> = ({ workflow, onExecute, onOpen }) => {
  const { deleteWorkflow, renameWorkflow } = useWorkflow();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(workflow.name);
  const [confirming, setConfirming] = useState(false);

  const handleRename = async (): Promise<void> => {
    if (editName.trim() && editName.trim() !== workflow.name) {
      await renameWorkflow(workflow.id, editName.trim());
    }
    setEditing(false);
  };

  return (
    <div
      className={cn(
        "group rounded-xl border border-border/50",
        "hover:border-border transition-all p-3.5 space-y-2.5",
      )}
    >
      <div>
        {editing ? (
          <div className="flex gap-1">
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
                if (e.key === "Escape") setEditing(false);
              }}
              className="flex-1 text-sm rounded-lg bg-background border border-border/50 px-2 py-0.5 outline-none focus:border-primary/40"
              autoFocus
            />
            <button
              onClick={handleRename}
              className="p-1 rounded hover:bg-primary/10 text-primary"
            >
              <Check className="size-3" />
            </button>
            <button
              onClick={() => setEditing(false)}
              className="p-1 rounded hover:bg-secondary text-muted-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium truncate">
              {workflow.name}
            </span>
            <button
              onClick={() => setEditing(true)}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-secondary text-muted-foreground transition-opacity"
            >
              <Pencil className="size-3" />
            </button>
          </div>
        )}
        <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
          <span>{workflow.stepCount} steps</span>
          <span>·</span>
          <span>{formatDuration(workflow.duration)}</span>
          <span>·</span>
          <span>{formatTime(workflow.createdAt)}</span>
        </div>
      </div>

      <div className="flex items-center gap-1 text-xs text-muted-foreground/70">
        <Navigation className="size-3 shrink-0" />
        <span className="truncate">{formatUrl(workflow.startUrl)}</span>
        <ChevronRight className="size-3 shrink-0" />
        <span className="truncate">{formatUrl(workflow.endUrl)}</span>
      </div>

      {workflow.datasetRowCount !== undefined &&
        workflow.datasetRowCount > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-primary">
            <Database className="size-3" />
            <span>
              {workflow.datasetRowCount} rows ·{" "}
              {(workflow.datasetColumns || []).join(", ")}
            </span>
          </div>
        )}

      <div className="flex gap-1.5">
        <button
          onClick={onOpen}
          className={cn(
            "flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-lg text-xs font-medium",
            "border border-border/50 hover:bg-secondary/50 transition-colors",
          )}
        >
          <Layers className="size-3" />
          Open
        </button>
        <button
          onClick={onExecute}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium",
            "bg-primary text-primary-foreground hover:opacity-90 transition-opacity",
          )}
        >
          <Play className="size-3" />
          Run
        </button>
        {confirming ? (
          <>
            <button
              onClick={async () => {
                await deleteWorkflow(workflow.id);
                setConfirming(false);
              }}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-red-500 hover:bg-red-500/10 transition-colors"
            >
              Delete
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-secondary transition-colors"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="p-1.5 rounded-lg hover:bg-red-500/10 hover:text-red-500 text-muted-foreground transition-colors"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};

// --- Execute modal (goal override) ---

const ExecuteModal: React.FC<{
  workflow: WorkflowSummary;
  onConfirm: (goal?: string) => void;
  onCancel: () => void;
}> = ({ workflow, onConfirm, onCancel }) => {
  const [goal, setGoal] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onCancel}
      />
      <div
        className={cn(
          "relative w-full rounded-xl p-4 space-y-3",
          "bg-background border border-border shadow-xl",
        )}
      >
        <div>
          <div className="text-sm font-semibold">
            Run &ldquo;{workflow.name}&rdquo;
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {workflow.stepCount} steps · {formatDuration(workflow.duration)}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">
            Optional: describe any variation or goal override
          </label>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={`Reproduce this workflow as-is, or describe changes...`}
            rows={3}
            className={cn(
              "w-full text-sm rounded-xl border border-border/50",
              "px-3 py-2 outline-none focus:border-primary/40 resize-none",
            )}
          />
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onConfirm(goal.trim() || undefined)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >
            <Play className="size-3.5" />
            Start agent
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:bg-secondary transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

// --- Workflow detail view ---

interface FullWorkflow {
  id: string;
  name: string;
  steps: Array<{
    id: string;
    timestamp: number;
    url: string;
    pageTitle: string;
    data: {
      type: string;
      payload: Record<string, unknown>;
    };
  }>;
  dataset?: WorkflowDataset;
}

const InteractionStepRow: React.FC<{
  workflowId: string;
  stepId: string;
  payload: Record<string, unknown>;
  dataset: WorkflowDataset | undefined;
  onRebind: () => Promise<void>;
}> = ({ workflowId, stepId, payload, dataset, onRebind }) => {
  const { bindStepToColumn } = useWorkflow();
  const eventType = String(payload.eventType || "");
  const tag = String(payload.tag || "");
  const label = String(payload.label || "");
  const value = String(payload.value || "");
  const selector = String(payload.selector || "");
  const parameter = payload.parameter as { column: string } | undefined;
  const currentColumn = parameter?.column ?? "";

  const handleChange = async (
    e: React.ChangeEvent<HTMLSelectElement>,
  ): Promise<void> => {
    const next = e.target.value;
    await bindStepToColumn(workflowId, stepId, next || null);
    await onRebind();
  };

  const verb =
    eventType === "click"
      ? "Click"
      : eventType === "submit"
        ? "Submit"
        : eventType === "keydown"
          ? `Press ${String(payload.key || "")}`
          : "Type";

  return (
    <div className="rounded-lg border border-border/40 p-2 space-y-1">
      <div className="flex items-baseline gap-1.5 text-xs">
        <span className="text-foreground font-medium">{verb}</span>
        <span className="text-muted-foreground">
          {tag}
          {label ? ` "${label}"` : ""}
        </span>
      </div>
      {(eventType === "input" || eventType === "change") && (
        <div className="text-[11px] font-mono text-muted-foreground truncate">
          value: {value || "(empty)"}
        </div>
      )}
      <div className="text-[10px] font-mono text-muted-foreground/60 truncate">
        {selector}
      </div>
      {dataset && (eventType === "input" || eventType === "change") && (
        <div className="flex items-center gap-1.5 pt-1">
          <Database className="size-3 text-primary shrink-0" />
          <span className="text-[11px] text-muted-foreground">from</span>
          <select
            value={currentColumn}
            onChange={handleChange}
            className={cn(
              "text-[11px] rounded-md border border-border/50 bg-background",
              "px-1.5 py-0.5 outline-none focus:border-primary/40 cursor-pointer",
            )}
          >
            <option value="">— literal —</option>
            {dataset.columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
};

const WorkflowDetailView: React.FC<{
  workflowId: string;
  onBack: () => void;
}> = ({ workflowId, onBack }) => {
  const {
    fetchWorkflow,
    attachDataset,
    clearDataset,
    executeBulkWorkflow,
    abortBulkWorkflow,
    bulkProgress,
    bulkResult,
    isExecuting,
  } = useWorkflow();
  const [workflow, setWorkflow] = useState<FullWorkflow | null>(null);
  const [uploading, setUploading] = useState(false);

  const reload = useCallback(async () => {
    const wf = (await fetchWorkflow(workflowId)) as FullWorkflow | null;
    setWorkflow(wf);
  }, [fetchWorkflow, workflowId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!workflow) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin mr-2" />
        Loading workflow…
      </div>
    );
  }

  const dataset = workflow.dataset;
  const interactionSteps = workflow.steps.filter(
    (s) => s.data.type === "interaction" || s.data.type === "navigation",
  );

  const handleAttach = async (d: WorkflowDataset): Promise<void> => {
    await attachDataset(workflowId, d);
    setUploading(false);
    await reload();
  };

  const handleClear = async (): Promise<void> => {
    await clearDataset(workflowId);
    await reload();
  };

  const handleRunAll = async (): Promise<void> => {
    if (!dataset || dataset.rows.length === 0) return;
    await executeBulkWorkflow(workflowId);
  };

  const progressBar = bulkProgress
    ? (bulkProgress.rowIndex + (bulkProgress.status === "running" ? 0 : 1)) /
      Math.max(bulkProgress.totalRows, 1)
    : null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <button
          onClick={onBack}
          className={cn(
            "flex items-center gap-1 text-xs text-muted-foreground",
            "hover:text-foreground transition-colors",
          )}
        >
          <ChevronLeft className="size-3.5" />
          Workflows
        </button>
        <span className="text-sm font-medium truncate ml-2">
          {workflow.name}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Dataset section */}
        <div className="rounded-xl border border-border/50 p-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <Database className="size-4 text-primary" />
            <div className="text-xs font-semibold">Dataset</div>
            {dataset && (
              <button
                onClick={handleClear}
                className="ml-auto text-xs text-muted-foreground hover:text-red-500 transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          {dataset ? (
            <>
              <div className="text-xs text-muted-foreground">
                {dataset.rows.length} rows · {dataset.columns.length} columns
                {dataset.source ? ` · from ${dataset.source}` : ""}
              </div>
              <div className="rounded-lg border border-border/40 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead className="bg-secondary/40">
                      <tr>
                        {dataset.columns.map((c) => (
                          <th
                            key={c}
                            className="text-left font-medium px-2 py-1 whitespace-nowrap"
                          >
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dataset.rows.slice(0, 5).map((row, i) => (
                        <tr key={i} className="border-t border-border/30">
                          {dataset.columns.map((c) => (
                            <td
                              key={c}
                              className="px-2 py-1 whitespace-nowrap text-muted-foreground"
                            >
                              {row[c] || ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {dataset.rows.length > 5 && (
                  <div className="px-2 py-1 text-[10px] text-muted-foreground/70 bg-secondary/20">
                    + {dataset.rows.length - 5} more rows
                  </div>
                )}
              </div>

              {isExecuting ? (
                <div className="space-y-1.5">
                  {bulkProgress && progressBar !== null && (
                    <>
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>
                          Row {bulkProgress.rowIndex + 1} of{" "}
                          {bulkProgress.totalRows} · {bulkProgress.status}
                        </span>
                        <span className="tabular-nums">
                          {Math.round(progressBar * 100)}%
                        </span>
                      </div>
                      <div className="h-1 rounded-full bg-secondary/40 overflow-hidden">
                        <div
                          className="h-full bg-primary transition-all"
                          style={{ width: `${progressBar * 100}%` }}
                        />
                      </div>
                    </>
                  )}
                  <button
                    onClick={abortBulkWorkflow}
                    className={cn(
                      "w-full flex items-center justify-center gap-1.5 py-1.5",
                      "rounded-lg text-xs font-medium",
                      "border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors",
                    )}
                  >
                    Stop bulk run
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleRunAll}
                  className={cn(
                    "w-full flex items-center justify-center gap-1.5 py-2 rounded-lg",
                    "text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity",
                  )}
                >
                  <Play className="size-3.5" />
                  Run for all {dataset.rows.length} rows
                </button>
              )}

              {bulkResult && bulkResult.workflowId === workflowId && (
                <div className="rounded-lg border border-border/40 px-2.5 py-2 text-xs space-y-0.5">
                  <div className="font-medium text-foreground">
                    Run complete · {bulkResult.successes}/{bulkResult.totalRows}{" "}
                    ok
                  </div>
                  {bulkResult.failures > 0 && (
                    <div className="text-red-500">
                      {bulkResult.failures} row(s) failed
                    </div>
                  )}
                  <div className="text-muted-foreground truncate">
                    Output: {bulkResult.csvPath}
                  </div>
                </div>
              )}
            </>
          ) : (
            <button
              onClick={() => setUploading(true)}
              className={cn(
                "w-full flex items-center justify-center gap-1.5 py-2 rounded-lg",
                "text-xs font-medium border border-border/60 hover:bg-secondary/50 transition-colors",
              )}
            >
              <Upload className="size-3.5" />
              Attach a CSV dataset
            </button>
          )}
        </div>

        {/* Steps */}
        <div className="rounded-xl border border-border/50 p-3 space-y-2">
          <div className="text-xs font-semibold">Recorded steps</div>
          <div className="space-y-1.5">
            {interactionSteps.map((step) => {
              if (step.data.type === "navigation") {
                const url = String(step.data.payload.toUrl || "");
                return (
                  <div
                    key={step.id}
                    className="rounded-lg border border-border/30 p-2 text-[11px] text-muted-foreground"
                  >
                    <Navigation className="size-3 inline mr-1 opacity-60" />
                    {formatUrl(url)}
                  </div>
                );
              }
              return (
                <InteractionStepRow
                  key={step.id}
                  workflowId={workflowId}
                  stepId={step.id}
                  payload={step.data.payload}
                  dataset={dataset}
                  onRebind={reload}
                />
              );
            })}
          </div>
        </div>
      </div>

      {uploading && (
        <DatasetUploader
          onParsed={handleAttach}
          onCancel={() => setUploading(false)}
        />
      )}
    </div>
  );
};

// --- Main panel ---

export const WorkflowPanel: React.FC = () => {
  const {
    recording,
    workflows,
    isExecuting,
    bulkProgress,
    startRecording,
    refreshWorkflows,
  } = useWorkflow();
  const [executing, setExecuting] = useState<WorkflowSummary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { executeWorkflow } = useWorkflow();

  useEffect(() => {
    refreshWorkflows();
  }, [refreshWorkflows]);

  const handleExecute = async (
    workflow: WorkflowSummary,
    goal?: string,
  ): Promise<void> => {
    setExecuting(null);
    await executeWorkflow(workflow.id, goal);
  };

  if (selectedId) {
    return (
      <div className="flex flex-col h-full bg-background">
        <WorkflowDetailView
          workflowId={selectedId}
          onBack={() => setSelectedId(null)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50">
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-semibold">Workflows</span>
          {recording.isRecording && (
            <span className="flex items-center gap-1.5 text-xs text-red-500">
              <span className="size-1.5 rounded-full bg-red-500 animate-pulse" />
              recording
            </span>
          )}
        </div>
        {!recording.isRecording && (
          <button
            onClick={startRecording}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium",
              "text-red-500 hover:bg-red-500/10 transition-colors",
            )}
          >
            <Circle className="size-3" />
            Record
          </button>
        )}
      </div>

      {/* Recording bar */}
      {recording.isRecording && (
        <div className="pt-3">
          <RecordingBar />
        </div>
      )}

      {/* Agent executing notice */}
      {isExecuting && (
        <div className="mx-3 my-2 flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin text-primary shrink-0" />
          {bulkProgress
            ? `Bulk run: row ${bulkProgress.rowIndex + 1}/${bulkProgress.totalRows}…`
            : "Agent is running the workflow…"}
        </div>
      )}

      {/* Workflow list */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {workflows.length === 0 ? (
          <div className="flex items-center justify-center h-full min-h-[200px]">
            <div className="text-center space-y-3">
              <div className="text-4xl">🫐</div>
              <h3 className="text-sm font-semibold">No workflows yet</h3>
              <p className="text-muted-foreground text-xs max-w-[220px]">
                Hit Record, browse the web, add notes along the way, then save.
                The AI will reproduce it on demand.
              </p>
              {!recording.isRecording && (
                <button
                  onClick={startRecording}
                  className={cn(
                    "mt-2 flex items-center gap-1.5 mx-auto px-4 py-2 rounded-lg text-xs font-medium",
                    "text-red-500 hover:bg-red-500/10 transition-colors",
                  )}
                >
                  <Circle className="size-3" />
                  Start recording
                </button>
              )}
            </div>
          </div>
        ) : (
          workflows.map((workflow) => (
            <WorkflowCard
              key={workflow.id}
              workflow={workflow}
              onExecute={() => setExecuting(workflow)}
              onOpen={() => setSelectedId(workflow.id)}
            />
          ))
        )}
      </div>

      {/* Execute modal */}
      {executing && (
        <ExecuteModal
          workflow={executing}
          onConfirm={(goal) => handleExecute(executing, goal)}
          onCancel={() => setExecuting(null)}
        />
      )}
    </div>
  );
};
