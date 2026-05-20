import React, { useRef, useState, useCallback } from "react";
import { Paperclip, X, Link, FileText, Send } from "lucide-react";
import { cn } from "@common/lib/utils";

export interface PromptAttachment {
  readonly id: string;
  readonly type: "url" | "file";
  readonly name: string;
  readonly content?: string;
  readonly url?: string;
  readonly mimeType?: string;
}

interface PromptInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly attachments: PromptAttachment[];
  readonly onAddAttachment: (attachment: PromptAttachment) => void;
  readonly onRemoveAttachment: (id: string) => void;
}

// App definitions: name patterns → display label + brand color + favicon URL
interface AppDef {
  readonly patterns: ReadonlyArray<string>;
  readonly label: string;
  readonly color: string;
  readonly favicon: string;
}

const APP_DEFS: ReadonlyArray<AppDef> = [
  {
    patterns: ["gmail", "google mail"],
    label: "Gmail",
    color: "#EA4335",
    favicon: "https://www.google.com/s2/favicons?domain=mail.google.com&sz=16",
  },
  {
    patterns: ["google calendar", "g calendar"],
    label: "Calendar",
    color: "#4285F4",
    favicon: "https://www.google.com/s2/favicons?domain=calendar.google.com&sz=16",
  },
  {
    patterns: ["google sheets", "g sheets", "spreadsheet"],
    label: "Sheets",
    color: "#34A853",
    favicon: "https://www.google.com/s2/favicons?domain=sheets.google.com&sz=16",
  },
  {
    patterns: ["google drive", "g drive"],
    label: "Drive",
    color: "#4285F4",
    favicon: "https://www.google.com/s2/favicons?domain=drive.google.com&sz=16",
  },
  {
    patterns: ["slack"],
    label: "Slack",
    color: "#4A154B",
    favicon: "https://www.google.com/s2/favicons?domain=slack.com&sz=16",
  },
  {
    patterns: ["linkedin"],
    label: "LinkedIn",
    color: "#0A66C2",
    favicon: "https://www.google.com/s2/favicons?domain=linkedin.com&sz=16",
  },
  {
    patterns: ["salesforce"],
    label: "Salesforce",
    color: "#00A1E0",
    favicon: "https://www.google.com/s2/favicons?domain=salesforce.com&sz=16",
  },
  {
    patterns: ["notion"],
    label: "Notion",
    color: "#000000",
    favicon: "https://www.google.com/s2/favicons?domain=notion.so&sz=16",
  },
  {
    patterns: ["hubspot"],
    label: "HubSpot",
    color: "#FF7A59",
    favicon: "https://www.google.com/s2/favicons?domain=hubspot.com&sz=16",
  },
  {
    patterns: ["github"],
    label: "GitHub",
    color: "#181717",
    favicon: "https://www.google.com/s2/favicons?domain=github.com&sz=16",
  },
  {
    patterns: ["airtable"],
    label: "Airtable",
    color: "#18BFFF",
    favicon: "https://www.google.com/s2/favicons?domain=airtable.com&sz=16",
  },
  {
    patterns: ["jira"],
    label: "Jira",
    color: "#0052CC",
    favicon: "https://www.google.com/s2/favicons?domain=atlassian.com&sz=16",
  },
  {
    patterns: ["trello"],
    label: "Trello",
    color: "#0052CC",
    favicon: "https://www.google.com/s2/favicons?domain=trello.com&sz=16",
  },
  {
    patterns: ["twitter", "x.com"],
    label: "X / Twitter",
    color: "#1DA1F2",
    favicon: "https://www.google.com/s2/favicons?domain=x.com&sz=16",
  },
  {
    patterns: ["instagram"],
    label: "Instagram",
    color: "#E4405F",
    favicon: "https://www.google.com/s2/favicons?domain=instagram.com&sz=16",
  },
  {
    patterns: ["youtube"],
    label: "YouTube",
    color: "#FF0000",
    favicon: "https://www.google.com/s2/favicons?domain=youtube.com&sz=16",
  },
];

function detectApps(text: string): ReadonlyArray<AppDef> {
  if (!text.trim()) return [];
  const lower = text.toLowerCase();
  const found: AppDef[] = [];
  for (const def of APP_DEFS) {
    if (def.patterns.some((p) => lower.includes(p))) {
      found.push(def);
    }
  }
  return found;
}

const AppChip: React.FC<{ app: AppDef }> = ({ app }) => (
  <span
    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border"
    style={{
      backgroundColor: app.color + "15",
      borderColor: app.color + "40",
      color: app.color,
    }}
  >
    <img
      src={app.favicon}
      alt=""
      className="size-3 rounded-sm"
      onError={(e) => {
        (e.target as HTMLImageElement).style.display = "none";
      }}
    />
    {app.label}
  </span>
);

const AttachmentChip: React.FC<{
  attachment: PromptAttachment;
  onRemove: () => void;
}> = ({ attachment, onRemove }) => (
  <span
    className={cn(
      "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-medium",
      "bg-secondary/70 border border-border/60 text-muted-foreground",
      "max-w-[140px]",
    )}
  >
    {attachment.type === "url" ? (
      <Link className="size-3 shrink-0 text-primary" />
    ) : (
      <FileText className="size-3 shrink-0 text-primary" />
    )}
    <span className="truncate">{attachment.name}</span>
    <button
      type="button"
      onClick={onRemove}
      className="ml-0.5 shrink-0 rounded-full hover:text-foreground transition-colors cursor-pointer"
    >
      <X className="size-2.5" />
    </button>
  </span>
);

// Popover for adding URL or file attachment
const AddAttachmentPopover: React.FC<{
  onAdd: (attachment: PromptAttachment) => void;
  onClose: () => void;
}> = ({ onAdd, onClose }) => {
  const [tab, setTab] = useState<"url" | "file">("url");
  const [urlValue, setUrlValue] = useState("");
  const [urlName, setUrlName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAddUrl = () => {
    const url = urlValue.trim();
    if (!url) return;
    const name = urlName.trim() || new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
    onAdd({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "url",
      name,
      url: url.startsWith("http") ? url : `https://${url}`,
    });
    onClose();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result;
      onAdd({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: "file",
        name: file.name,
        content: typeof content === "string" ? content : undefined,
        mimeType: file.type,
      });
      onClose();
    };
    if (file.type.startsWith("text/") || file.name.endsWith(".csv") || file.name.endsWith(".json") || file.name.endsWith(".md")) {
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file);
    }
  };

  return (
    <div
      className={cn(
        "absolute bottom-full left-0 mb-2 w-72 z-50",
        "rounded-2xl border border-border bg-background shadow-lg p-3 space-y-3",
      )}
    >
      <div className="flex gap-1 p-0.5 bg-secondary/50 rounded-lg">
        {(["url", "file"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer",
              tab === t
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "url" ? "Link" : "File"}
          </button>
        ))}
      </div>

      {tab === "url" ? (
        <div className="space-y-2">
          <input
            autoFocus
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddUrl()}
            placeholder="https://..."
            className={cn(
              "w-full text-xs rounded-lg bg-background border border-border/60 px-2 py-1.5",
              "outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20",
            )}
          />
          <input
            value={urlName}
            onChange={(e) => setUrlName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddUrl()}
            placeholder="Label (optional)"
            className={cn(
              "w-full text-xs rounded-lg bg-background border border-border/60 px-2 py-1.5",
              "outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20",
            )}
          />
          <button
            type="button"
            onClick={handleAddUrl}
            disabled={!urlValue.trim()}
            className={cn(
              "w-full py-1.5 text-xs font-medium rounded-lg",
              "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40",
              "transition-opacity cursor-pointer disabled:cursor-not-allowed",
            )}
          >
            Add link
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "w-full py-3 text-xs text-muted-foreground rounded-lg border border-dashed border-border/60",
              "hover:border-primary/40 hover:text-foreground transition-colors cursor-pointer",
            )}
          >
            Click to pick a file
          </button>
          <p className="text-[10px] text-muted-foreground/60 text-center">
            Text, CSV, JSON, Markdown files work best
          </p>
        </div>
      )}
    </div>
  );
};

export const PromptInput: React.FC<PromptInputProps> = ({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  attachments,
  onAddAttachment,
  onRemoveAttachment,
}) => {
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const detectedApps = detectApps(value);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
      if (e.key === "Escape") {
        setShowAttachMenu(false);
      }
    },
    [onSubmit],
  );

  return (
    <div className="space-y-2">
      {/* App chips — only shown when apps are detected */}
      {detectedApps.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1">
          {detectedApps.map((app) => (
            <AppChip key={app.label} app={app} />
          ))}
        </div>
      )}

      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1">
          {attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              attachment={a}
              onRemove={() => onRemoveAttachment(a.id)}
            />
          ))}
        </div>
      )}

      {/* Input row */}
      <div
        ref={containerRef}
        className={cn(
          "relative flex items-end gap-2 rounded-xl px-3 py-2",
          "border border-border/60 focus-within:border-primary/40 focus-within:ring-1 focus-within:ring-primary/10",
          "transition-all",
        )}
      >
        {showAttachMenu && (
          <AddAttachmentPopover
            onAdd={onAddAttachment}
            onClose={() => setShowAttachMenu(false)}
          />
        )}

        {/* Attachment button */}
        <button
          type="button"
          onClick={() => setShowAttachMenu((v) => !v)}
          disabled={disabled}
          title="Attach URL or file"
          className={cn(
            "size-6 rounded-lg flex items-center justify-center shrink-0 transition-colors",
            "text-muted-foreground hover:text-foreground hover:bg-muted",
            "disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer",
            showAttachMenu && "bg-muted text-foreground",
          )}
        >
          <Paperclip className="size-3.5" />
        </button>

        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder ?? "Ask anything..."}
          className="flex-1 resize-none outline-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground min-h-[20px] max-h-[120px] py-1 disabled:opacity-50"
          rows={1}
        />

        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled || (!value.trim() && attachments.length === 0)}
          className={cn(
            "size-7 rounded-lg flex items-center justify-center shrink-0 transition-all",
            "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed",
          )}
        >
          <Send className="size-3.5" />
        </button>
      </div>
    </div>
  );
};
