import React, { useRef, useState, useCallback, useEffect } from "react";
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

// ─── Autocomplete suggestions ──────────────────────────────────────────────────

interface AutocompleteSuggestion {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly completion: string;
  // One or more trigger substrings (EN + SV) — any match shows this suggestion
  readonly triggers: ReadonlyArray<string>;
}

const AUTOCOMPLETE_SUGGESTIONS: ReadonlyArray<AutocompleteSuggestion> = [
  // Gmail — Inbox
  {
    id: "gmail-inbox",
    label: "Gmail Inbox",
    description: "Öppna / Open inbox",
    completion: "Show my Gmail inbox and unread emails",
    triggers: [
      "gmail inbox",
      "gmail inkorg",
      "inkorgen",
      "läs mail",
      "kolla mail",
      "öppna gmail",
      "visa mail",
      "check gmail",
      "check email",
      "show inbox",
      "my inbox",
    ],
  },
  // Gmail — Send
  {
    id: "gmail-send",
    label: "Send Gmail",
    description: "Skicka / Send email",
    completion: "Send an email via Gmail to ",
    triggers: [
      "skicka mail",
      "skicka mejl",
      "skicka e-post",
      "maila",
      "send email",
      "send mail",
      "compose email",
      "write email",
      "send via gmail",
    ],
  },
  // Gmail — Search
  {
    id: "gmail-search",
    label: "Search Gmail",
    description: "Sök / Search emails",
    completion: "Search my Gmail for ",
    triggers: [
      "sök mail",
      "sök mejl",
      "hitta mail",
      "search gmail",
      "search email",
      "find email",
    ],
  },
  // Gmail — Reply
  {
    id: "gmail-reply",
    label: "Reply to Email",
    description: "Svara / Reply",
    completion: "Reply to the latest email from ",
    triggers: [
      "svara på mail",
      "svara på mejl",
      "reply to email",
      "reply to gmail",
      "respond to email",
    ],
  },
  // Calendar
  {
    id: "calendar-check",
    label: "Google Calendar",
    description: "Visa / Show calendar",
    completion: "Show my Google Calendar for ",
    triggers: [
      "kolla kalender",
      "visa kalender",
      "google calendar",
      "my calendar",
      "my meetings",
      "check calendar",
    ],
  },
  // Sheets
  {
    id: "sheets-open",
    label: "Google Sheets",
    description: "Öppna / Open spreadsheet",
    completion: "Open Google Sheets and ",
    triggers: ["google sheets", "kalkylark", "spreadsheet", "öppna sheets"],
  },
  // Slack — DM
  {
    id: "slack-message",
    label: "Slack Message",
    description: "Skicka Slack-meddelande",
    completion: "Send a Slack message to ",
    triggers: [
      "slack message",
      "skicka slack",
      "dm on slack",
      "slack dm",
      "message on slack",
    ],
  },
];

function getAutocompleteSuggestions(
  text: string,
): ReadonlyArray<AutocompleteSuggestion> {
  if (!text.trim() || text.length < 3) return [];
  const lower = text.toLowerCase();
  const results: AutocompleteSuggestion[] = [];

  for (const s of AUTOCOMPLETE_SUGGESTIONS) {
    if (
      s.triggers.some(
        (t) => lower.includes(t) || t.startsWith(lower.split(" ").pop() ?? ""),
      )
    ) {
      results.push(s);
    }
  }

  return results.slice(0, 4);
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

const AutocompleteDropdown: React.FC<{
  suggestions: ReadonlyArray<AutocompleteSuggestion>;
  activeIndex: number;
  onSelect: (s: AutocompleteSuggestion) => void;
}> = ({ suggestions, activeIndex, onSelect }) => {
  if (suggestions.length === 0) return null;

  return (
    <div
      className={cn(
        "absolute bottom-full left-0 right-0 mb-1.5 z-50",
        "rounded-xl border border-border bg-background shadow-lg overflow-hidden",
      )}
    >
      {suggestions.map((s, i) => (
        <button
          key={s.id}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(s);
          }}
          className={cn(
            "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
            i === activeIndex ? "bg-secondary" : "hover:bg-secondary/50",
          )}
        >
          <span className="text-xs font-medium text-foreground shrink-0">
            {s.label}
          </span>
          <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
            {s.description}
          </span>
        </button>
      ))}
      <div className="px-3 py-1 border-t border-border/40 text-[9px] text-muted-foreground/50 flex items-center gap-1">
        <span>↑↓ navigate</span>
        <span>·</span>
        <span>Enter / Tab to select</span>
        <span>·</span>
        <span>Esc dismiss</span>
      </div>
    </div>
  );
};

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
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const detectedApps = detectApps(value);
  const containerRef = useRef<HTMLDivElement>(null);

  const autocompleteSuggestions = getAutocompleteSuggestions(value);

  // Show autocomplete when there are suggestions and the user is actively editing
  useEffect(() => {
    if (autocompleteSuggestions.length > 0) {
      setShowAutocomplete(true);
      setAutocompleteIndex(0);
    } else {
      setShowAutocomplete(false);
    }
  }, [autocompleteSuggestions.length]);

  const applyAutocomplete = useCallback(
    (s: AutocompleteSuggestion) => {
      onChange(s.completion);
      setShowAutocomplete(false);
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showAutocomplete && autocompleteSuggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAutocompleteIndex((i) => (i + 1) % autocompleteSuggestions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAutocompleteIndex((i) =>
            i === 0 ? autocompleteSuggestions.length - 1 : i - 1,
          );
          return;
        }
        if (
          e.key === "Tab" ||
          (e.key === "Enter" && !e.shiftKey && autocompleteIndex >= 0)
        ) {
          e.preventDefault();
          applyAutocomplete(autocompleteSuggestions[autocompleteIndex]);
          return;
        }
        if (e.key === "Escape") {
          setShowAutocomplete(false);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
      if (e.key === "Escape") {
        setShowAttachMenu(false);
      }
    },
    [
      onSubmit,
      showAutocomplete,
      autocompleteSuggestions,
      autocompleteIndex,
      applyAutocomplete,
    ],
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

        {showAutocomplete && !showAttachMenu && (
          <AutocompleteDropdown
            suggestions={autocompleteSuggestions}
            activeIndex={autocompleteIndex}
            onSelect={applyAutocomplete}
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
