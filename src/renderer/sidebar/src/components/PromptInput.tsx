import React, { useRef, useState, useCallback } from "react";
import {
  Paperclip,
  X,
  Link,
  FileText,
  Send,
  Mail,
  Inbox,
  Search,
  Reply,
  Calendar,
  FileSpreadsheet,
  HardDrive,
} from "lucide-react";
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

// ─── App chip definitions ──────────────────────────────────────────────────────
// Action-specific entries for Gmail come first so they win over the generic match.

interface AppDef {
  readonly patterns: ReadonlyArray<string>;
  readonly label: string;
  readonly color: string;
  readonly favicon: string;
  readonly actionIcon?: React.ReactNode;
}

const GMAIL_RED = "#EA4335";
const GMAIL_FAVICON =
  "https://www.google.com/s2/favicons?domain=mail.google.com&sz=16";

const APP_DEFS: ReadonlyArray<AppDef> = [
  // Gmail — action-specific (checked before the generic Gmail entry)
  {
    patterns: [
      "skicka mail",
      "skicka mejl",
      "skicka e-post",
      "skicka det till",
      "skicka den till",
      "maila ",
      "send email",
      "send mail",
      "send an email",
      "compose email",
      "write email",
      "send via gmail",
      "send it to",
      "send this to",
    ],
    label: "Send Gmail",
    color: GMAIL_RED,
    favicon: GMAIL_FAVICON,
    actionIcon: <Mail className="size-2.5" />,
  },
  {
    patterns: [
      "gmail inbox",
      "gmail inkorg",
      "inkorgen",
      "läs mail",
      "läs mejl",
      "kolla mail",
      "kolla mejl",
      "öppna gmail",
      "visa mail",
      "check gmail",
      "check email",
      "check my email",
      "show inbox",
      "my emails",
      "my inbox",
    ],
    label: "Gmail Inbox",
    color: GMAIL_RED,
    favicon: GMAIL_FAVICON,
    actionIcon: <Inbox className="size-2.5" />,
  },
  {
    patterns: [
      "sök mail",
      "sök mejl",
      "hitta mail",
      "search gmail",
      "search email",
      "find email",
      "search my email",
    ],
    label: "Search Gmail",
    color: GMAIL_RED,
    favicon: GMAIL_FAVICON,
    actionIcon: <Search className="size-2.5" />,
  },
  {
    patterns: [
      "svara på mail",
      "svara på mejl",
      "reply to email",
      "reply to gmail",
      "respond to email",
      "reply to",
    ],
    label: "Reply Email",
    color: GMAIL_RED,
    favicon: GMAIL_FAVICON,
    actionIcon: <Reply className="size-2.5" />,
  },
  // Generic Gmail fallback
  {
    patterns: ["gmail", "google mail"],
    label: "Gmail",
    color: GMAIL_RED,
    favicon: GMAIL_FAVICON,
  },
  {
    patterns: ["google calendar", "g calendar", "kalender", "calendar"],
    label: "Calendar",
    color: "#4285F4",
    favicon:
      "https://www.google.com/s2/favicons?domain=calendar.google.com&sz=16",
    actionIcon: <Calendar className="size-2.5" />,
  },
  {
    patterns: ["google sheets", "g sheets", "spreadsheet", "kalkylark"],
    label: "Sheets",
    color: "#34A853",
    favicon:
      "https://www.google.com/s2/favicons?domain=sheets.google.com&sz=16",
    actionIcon: <FileSpreadsheet className="size-2.5" />,
  },
  {
    patterns: ["google drive", "g drive"],
    label: "Drive",
    color: "#4285F4",
    favicon: "https://www.google.com/s2/favicons?domain=drive.google.com&sz=16",
    actionIcon: <HardDrive className="size-2.5" />,
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

// Return unique apps matched, letting the most specific pattern win.
// We track which domains have already been matched so the specific Gmail action
// chip doesn't appear alongside the generic Gmail chip.
function detectApps(text: string): ReadonlyArray<AppDef> {
  if (!text.trim()) return [];
  const lower = text.toLowerCase();
  const found: AppDef[] = [];
  const seenFavicons = new Set<string>();

  for (const def of APP_DEFS) {
    if (seenFavicons.has(def.favicon)) continue;
    if (def.patterns.some((p) => lower.includes(p))) {
      found.push(def);
      seenFavicons.add(def.favicon);
    }
  }

  return found;
}

// ─── Inline word-level autocomplete ────────────────────────────────────────────

interface WordCompletion {
  readonly textBefore: string;
  readonly label: string;
  readonly suffix: string;
  readonly favicon: string;
}

// [typed-word-lowercase, display-label, favicon-url]
const WORD_COMPLETIONS: ReadonlyArray<readonly [string, string, string]> = [
  ["gmail", "Gmail", GMAIL_FAVICON],
  ["slack", "Slack", "https://www.google.com/s2/favicons?domain=slack.com&sz=16"],
  ["linkedin", "LinkedIn", "https://www.google.com/s2/favicons?domain=linkedin.com&sz=16"],
  ["calendar", "Calendar", "https://www.google.com/s2/favicons?domain=calendar.google.com&sz=16"],
  ["notion", "Notion", "https://www.google.com/s2/favicons?domain=notion.so&sz=16"],
  ["salesforce", "Salesforce", "https://www.google.com/s2/favicons?domain=salesforce.com&sz=16"],
  ["sheets", "Sheets", "https://www.google.com/s2/favicons?domain=sheets.google.com&sz=16"],
  ["drive", "Drive", "https://www.google.com/s2/favicons?domain=drive.google.com&sz=16"],
  ["hubspot", "HubSpot", "https://www.google.com/s2/favicons?domain=hubspot.com&sz=16"],
  ["github", "GitHub", "https://www.google.com/s2/favicons?domain=github.com&sz=16"],
  ["airtable", "Airtable", "https://www.google.com/s2/favicons?domain=airtable.com&sz=16"],
  ["jira", "Jira", "https://www.google.com/s2/favicons?domain=atlassian.com&sz=16"],
  ["trello", "Trello", "https://www.google.com/s2/favicons?domain=trello.com&sz=16"],
];

function getWordCompletion(text: string): WordCompletion | null {
  if (!text) return null;
  const m = text.match(/(\S+)$/);
  if (!m) return null;
  const typed = m[1];
  const lower = typed.toLowerCase();
  if (lower.length < 2) return null;

  for (const [word, label, favicon] of WORD_COMPLETIONS) {
    if (word.startsWith(lower) && word !== lower) {
      return {
        textBefore: text.slice(0, text.length - typed.length),
        label,
        // suffix uses the label's casing, sliced past what was typed
        suffix: label.slice(typed.length),
        favicon,
      };
    }
  }
  return null;
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
    {app.actionIcon && <span className="opacity-80">{app.actionIcon}</span>}
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

  const handleAddUrl = (): void => {
    const url = urlValue.trim();
    if (!url) return;
    const name =
      urlName.trim() ||
      new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
    onAdd({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "url",
      name,
      url: url.startsWith("http") ? url : `https://${url}`,
    });
    onClose();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
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
    if (
      file.type.startsWith("text/") ||
      file.name.endsWith(".csv") ||
      file.name.endsWith(".json") ||
      file.name.endsWith(".md")
    ) {
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
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileChange}
          />
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

  const wordCompletion = getWordCompletion(value);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (wordCompletion && e.key === "Tab") {
        e.preventDefault();
        onChange(wordCompletion.textBefore + wordCompletion.label);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
      if (e.key === "Escape") {
        setShowAttachMenu(false);
      }
    },
    [onSubmit, wordCompletion, onChange],
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

        {/* Textarea with inline ghost-text word completion */}
        <div className="relative flex-1">
          {wordCompletion && !showAttachMenu && (
            <div
              aria-hidden
              className="absolute inset-0 pointer-events-none text-sm py-1 overflow-hidden"
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                overflowWrap: "break-word",
              }}
            >
              {/* Transparent clone positions the ghost suffix at the cursor */}
              <span style={{ color: "transparent" }}>{value}</span>
              <span className="inline-flex items-center gap-0.5 text-muted-foreground/40">
                {wordCompletion.suffix}
                <img
                  src={wordCompletion.favicon}
                  alt=""
                  className="size-3 rounded-sm ml-0.5 inline-block align-text-bottom opacity-50"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              </span>
            </div>
          )}
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={placeholder ?? "Ask anything..."}
            className="w-full resize-none outline-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground min-h-[20px] max-h-[120px] py-1 disabled:opacity-50"
            rows={1}
          />
        </div>

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
