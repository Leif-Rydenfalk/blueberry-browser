import React, { useState, useRef, useEffect } from "react";
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
  Loader2,
} from "lucide-react";

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

// --- Recording bar ---

const RecordingBar: React.FC = () => {
  const { recording, stopRecording, cancelRecording, addAnnotation } =
    useWorkflow();
  const [saveName, setSaveName] = useState("");
  const [annotation, setAnnotation] = useState("");
  const [saving, setSaving] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const elapsed = recording.startedAt
    ? Math.round((Date.now() - recording.startedAt) / 1000)
    : 0;

  const handleSave = async () => {
    const name =
      saveName.trim() || `Workflow ${new Date().toLocaleDateString()}`;
    setSaving(true);
    await stopRecording(name);
    setSaveName("");
    setSaving(false);
  };

  const handleAnnotate = async () => {
    if (!annotation.trim()) return;
    await addAnnotation(annotation.trim());
    setAnnotation("");
    setAnnotating(false);
  };

  return (
    <div className="mx-3 mb-2 rounded-2xl border border-red-500/30 bg-red-500/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-red-500 animate-pulse shrink-0" />
        <span className="text-xs font-semibold text-red-500">Recording</span>
        <span className="text-xs text-muted-foreground ml-auto">
          {recording.stepCount} steps · {elapsed}s
        </span>
      </div>

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
            "border border-border/40 bg-background/60 hover:bg-background",
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
}

const WorkflowCard: React.FC<{
  workflow: WorkflowSummary;
  onExecute: () => void;
}> = ({ workflow, onExecute }) => {
  const { deleteWorkflow, renameWorkflow } = useWorkflow();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(workflow.name);
  const [confirming, setConfirming] = useState(false);

  const handleRename = async () => {
    if (editName.trim() && editName.trim() !== workflow.name) {
      await renameWorkflow(workflow.id, editName.trim());
    }
    setEditing(false);
  };

  return (
    <div
      className={cn(
        "group rounded-2xl border border-border/50 bg-background/60",
        "hover:border-border hover:bg-background transition-all p-3 space-y-2",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="size-8 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <span className="text-base">🫐</span>
        </div>
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex gap-1">
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRename();
                  if (e.key === "Escape") setEditing(false);
                }}
                className="flex-1 text-sm rounded-md bg-background border border-border/50 px-2 py-0.5 outline-none focus:border-primary/40"
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
                className="p-1 rounded hover:bg-muted text-muted-foreground"
              >
                <X className="size-3" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <span className="text-sm font-medium truncate">
                {workflow.name}
              </span>
              <button
                onClick={() => setEditing(true)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted text-muted-foreground transition-opacity"
              >
                <Pencil className="size-3" />
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
            <span>{workflow.stepCount} steps</span>
            <span>·</span>
            <span>{formatDuration(workflow.duration)}</span>
            <span>·</span>
            <span>{formatTime(workflow.createdAt)}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 text-xs text-muted-foreground/70">
        <Navigation className="size-3 shrink-0" />
        <span className="truncate">{formatUrl(workflow.startUrl)}</span>
        <ChevronRight className="size-3 shrink-0" />
        <span className="truncate">{formatUrl(workflow.endUrl)}</span>
      </div>

      <div className="flex gap-1.5 pt-0.5">
        <button
          onClick={onExecute}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-xs font-medium",
            "bg-primary text-primary-foreground hover:opacity-90 transition-opacity",
          )}
        >
          <Play className="size-3" />
          Run workflow
        </button>
        {confirming ? (
          <>
            <button
              onClick={async () => {
                await deleteWorkflow(workflow.id);
                setConfirming(false);
              }}
              className="px-2.5 py-1.5 rounded-xl text-xs font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors"
            >
              Delete
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="px-2.5 py-1.5 rounded-xl text-xs border border-border/50 hover:bg-muted text-muted-foreground transition-colors"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="p-1.5 rounded-xl border border-border/50 hover:bg-red-500/10 hover:border-red-500/30 text-muted-foreground hover:text-red-500 transition-colors"
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
          "relative w-full rounded-2xl p-4 space-y-3",
          "bg-background border border-border/60 shadow-lg",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">🫐</span>
          <div>
            <div className="text-sm font-semibold">Run "{workflow.name}"</div>
            <div className="text-xs text-muted-foreground">
              {workflow.stepCount} steps · {formatDuration(workflow.duration)}
            </div>
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
              "w-full text-sm rounded-xl border border-border/50 bg-secondary/30",
              "px-3 py-2 outline-none focus:border-primary/40 resize-none",
            )}
          />
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onConfirm(goal.trim() || undefined)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >
            <Play className="size-3.5" />
            Start agent
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-sm border border-border/50 hover:bg-muted text-muted-foreground transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

// --- Main panel ---

export const WorkflowPanel: React.FC = () => {
  const {
    recording,
    workflows,
    isExecuting,
    startRecording,
    refreshWorkflows,
  } = useWorkflow();
  const [executing, setExecuting] = useState<WorkflowSummary | null>(null);
  const { executeWorkflow } = useWorkflow();

  useEffect(() => {
    refreshWorkflows();
  }, [refreshWorkflows]);

  const handleExecute = async (workflow: WorkflowSummary, goal?: string) => {
    setExecuting(null);
    await executeWorkflow(workflow.id, goal);
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <div className="size-7 rounded-lg bg-primary/10 flex items-center justify-center">
            <span className="text-sm">🫐</span>
          </div>
          <span className="text-sm font-semibold">Workflows</span>
          {recording.isRecording && (
            <span className="flex items-center gap-1 text-xs text-red-500">
              <span className="size-1.5 rounded-full bg-red-500 animate-pulse" />
              recording
            </span>
          )}
        </div>
        {!recording.isRecording && (
          <button
            onClick={startRecording}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium",
              "bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20 transition-colors",
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
        <div className="mx-3 my-2 flex items-center gap-2 rounded-xl bg-primary/5 border border-primary/20 px-3 py-2 text-xs text-primary">
          <Loader2 className="size-3.5 animate-spin" />
          Agent is running the workflow...
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
                    "mt-2 flex items-center gap-1.5 mx-auto px-4 py-2 rounded-xl text-xs font-medium",
                    "bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20 transition-colors",
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
