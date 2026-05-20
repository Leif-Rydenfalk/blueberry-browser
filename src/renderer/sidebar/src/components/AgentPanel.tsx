import React, { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { useAgent } from "../contexts/AgentContext";
import type { AgentStep } from "../contexts/AgentContext";
import {
  Square,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  XCircle,
  Loader2,
  MousePointer,
  Type,
  Keyboard,
  ScrollText,
  Camera,
  Navigation,
  Search,
  Flag,
  Send,
  KeyRound,
} from "lucide-react";
import { cn } from "@common/lib/utils";
import { Button } from "@common/components/Button";
import { ApprovalSheet } from "./ApprovalSheet";
import { ScriptReviewSheet } from "./ScriptReviewSheet";
import { CsvViewer } from "./CsvViewer";
import { ApiKeyManagerModal } from "./ApiKeyManagerModal";

interface ModelOption {
  readonly provider: "openai" | "anthropic" | "google";
  readonly model: string;
  readonly label: string;
}

interface ModelSelection extends ModelOption {
  readonly configured: boolean;
}

const ActionIcon: React.FC<{ type: string }> = ({ type }) => {
  switch (type) {
    case "navigate":
      return <Navigation className="size-3" />;
    case "click":
      return <MousePointer className="size-3" />;
    case "type":
      return <Type className="size-3" />;
    case "key":
      return <Keyboard className="size-3" />;
    case "scroll":
      return <ScrollText className="size-3" />;
    case "screenshot":
      return <Camera className="size-3" />;
    case "extract":
    case "extractSchema":
      return <Search className="size-3" />;
    case "executeScript":
      return <Send className="size-3" />;
    case "finish":
      return <Flag className="size-3" />;
    default:
      return <div className="size-3 rounded-full bg-muted" />;
  }
};

const StatusIcon: React.FC<{ status: string }> = ({ status }) => {
  switch (status) {
    case "success":
      return <CheckCircle2 className="size-3 text-green-500" />;
    case "error":
      return <XCircle className="size-3 text-red-500" />;
    case "running":
      return <Loader2 className="size-3 text-primary animate-spin" />;
    case "pending":
      return (
        <div className="size-3 rounded-full border-2 border-muted-foreground/30" />
      );
    default:
      return null;
  }
};

// Pull plain text out of a react-markdown code-block child tree. The model's
// CSV lives inside a `pre > code.language-csv` whose children is the raw text,
// often wrapped in nested React nodes when react-markdown processes line breaks.
const extractText = (node: React.ReactNode): string => {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return extractText(props.children);
  }
  return "";
};

const markdownComponents = {
  // Replace fenced CSV blocks with the rich viewer (table + copy + download).
  // Other code blocks render with default prose styles.
  pre: ({ children, ...rest }: React.HTMLAttributes<HTMLPreElement>) => {
    const child = React.Children.toArray(children)[0];
    if (React.isValidElement(child)) {
      const childProps = child.props as {
        className?: string;
        children?: React.ReactNode;
      };
      const language = (childProps.className || "")
        .split(" ")
        .find((c) => c.startsWith("language-"))
        ?.replace("language-", "");
      if (language === "csv") {
        const csv = extractText(childProps.children).replace(/\n$/, "");
        return <CsvViewer csv={csv} />;
      }
    }
    return <pre {...rest}>{children}</pre>;
  },
};

const MarkdownMessage: React.FC<{ content: string }> = ({ content }) => (
  <div
    className="prose prose-sm dark:prose-invert max-w-none
    prose-headings:text-foreground prose-p:text-foreground prose-strong:text-foreground
    prose-a:text-primary hover:prose-a:underline
    prose-code:bg-secondary prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:text-xs prose-code:font-mono
    prose-pre:bg-secondary dark:prose-pre:bg-secondary/50 prose-pre:p-3 prose-pre:rounded-xl prose-pre:text-xs"
  >
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      components={markdownComponents}
    >
      {content}
    </ReactMarkdown>
  </div>
);

const getActionSummary = (step: AgentStep) => {
  switch (step.action.type) {
    case "navigate":
      return `Navigate to ${(step.action.params as any).url || "page"}`;
    case "click":
      return `Click ${(step.action.params as any).selector || "coordinates"}`;
    case "type":
      return `Type "${(step.action.params as any).text || ""}"`;
    case "key":
      return `Key ${(step.action.params as any).key || ""}`;
    case "scroll":
      return `Scroll ${(step.action.params as any).direction || ""}`;
    case "extract":
    case "extractSchema":
      return `Extract ${(step.action.params as any).name || "data"}`;
    case "executeScript":
      return (step.action.params as any).description || "Run script";
    case "screenshot":
      return "Screenshot";
    case "finish":
      return "Done";
    default:
      return step.action.type;
  }
};

const AgentStepMessage: React.FC<{
  step: AgentStep;
  expanded: boolean;
  onToggle: () => void;
}> = ({ step, expanded, onToggle }) => (
  <div>
    <div
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-xs",
        "hover:bg-secondary transition-colors",
        step.status === "running" && "text-primary",
      )}
      onClick={onToggle}
    >
      <StatusIcon status={step.status} />
      <ActionIcon type={step.action.type} />
      <span className="truncate flex-1">{getActionSummary(step)}</span>
      <span className="text-muted-foreground shrink-0 tabular-nums">
        {step.step}/{step.totalSteps}
      </span>
      {expanded ? (
        <ChevronUp className="size-3 text-muted-foreground shrink-0" />
      ) : (
        <ChevronDown className="size-3 text-muted-foreground shrink-0" />
      )}
    </div>

    {expanded && (
      <div className="ml-6 mt-1 mb-1 space-y-2 text-xs">
        {step.action.reasoning && (
          <p className="text-muted-foreground">{step.action.reasoning}</p>
        )}
        {step.result && !step.result.success && (
          <p className="text-red-500">{step.result.error}</p>
        )}
        {step.result?.success && step.result.data !== undefined && (
          <pre className="max-h-40 overflow-auto rounded-lg bg-secondary p-2 text-[11px] text-muted-foreground">
            {typeof step.result.data === "string"
              ? step.result.data
              : JSON.stringify(step.result.data, null, 2)}
          </pre>
        )}
        {step.screenshot && (
          <img
            src={step.screenshot}
            alt={`Step ${step.step} screenshot`}
            className="rounded-lg border border-border/50 max-w-full"
          />
        )}
      </div>
    )}
  </div>
);

interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

const formatTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export const AgentPanel: React.FC = () => {
  const {
    messages,
    isRunning,
    currentStep,
    maxSteps,
    goal,
    pendingApproval,
    pendingScriptReview,
    startAgent,
    abortAgent,
    sendMessage,
    clearAgent,
    resolveApproval,
    resolveScriptReview,
  } = useAgent();
  const [input, setInput] = useState("");
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(
    null,
  );
  const [modelError, setModelError] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const loadModelSettings = async () => {
      try {
        const [options, selection] = await Promise.all([
          window.sidebarAPI.getModelOptions(),
          window.sidebarAPI.getModelSelection(),
        ]);
        setModelOptions(options);
        setModelSelection(selection);
      } catch (error) {
        console.error("Failed to load model settings:", error);
        setModelError("Models unavailable");
      }
    };

    loadModelSettings();
  }, []);

  useEffect(() => {
    const loadUsage = async () => {
      const usage = await window.sidebarAPI.getTokenUsage();
      if (usage) setTokenUsage(usage);
    };
    loadUsage();
    window.sidebarAPI.onTokenUsageUpdated(setTokenUsage);
    return () => window.sidebarAPI.removeTokenUsageUpdatedListener();
  }, []);

  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!input.trim()) return;
    const text = input.trim();
    setInput("");
    if (isRunning) {
      await sendMessage(text);
    } else {
      await startAgent(text);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleModelChange = async (value: string) => {
    const [provider, model] = value.split(":");
    if (
      (provider !== "openai" &&
        provider !== "anthropic" &&
        provider !== "google") ||
      !model
    )
      return;

    setModelError(null);
    try {
      const selection = await window.sidebarAPI.setModelSelection({
        provider,
        model,
      });
      setModelSelection(selection);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to switch model";
      setModelError(message);
    }
  };

  const refreshModelOptions = async (): Promise<void> => {
    try {
      const [options, selection] = await Promise.all([
        window.sidebarAPI.getModelOptions(),
        window.sidebarAPI.getModelSelection(),
      ]);
      setModelOptions(options);
      setModelSelection(selection);
      setModelError(null);
    } catch (error) {
      console.error("Failed to refresh model settings:", error);
    }
  };

  const selectedModelValue = modelSelection
    ? `${modelSelection.provider}:${modelSelection.model}`
    : "";

  return (
    <div className="relative flex flex-col h-full bg-background">
      {/* Header — two rows so brand, status, model picker, and actions never crowd each other */}
      <div className="border-b border-border/50">
        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-base shrink-0">🫐</span>
            <span className="text-sm font-semibold text-foreground truncate">
              Blueberry AI
            </span>
            {isRunning && (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground shrink-0">
                <span className="size-1.5 rounded-full bg-primary animate-pulse" />
                working
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {messages.length > 0 && !isRunning && (
              <Button
                onClick={clearAgent}
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1 px-2.5"
              >
                <Square className="size-3" /> Clear
              </Button>
            )}
            {isRunning && (
              <Button
                onClick={abortAgent}
                variant="destructive"
                size="sm"
                className="h-7 text-xs gap-1 px-2.5"
              >
                <Square className="size-3" /> Stop
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 px-4 pb-2.5">
          <div
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-lg flex-1 min-w-0",
              "bg-secondary/50 hover:bg-secondary transition-colors",
              "border border-border/40",
              (isRunning || modelOptions.length === 0) &&
                "opacity-60 cursor-not-allowed",
            )}
          >
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 shrink-0">
              Model
            </span>
            <select
              value={selectedModelValue}
              onChange={(event) => handleModelChange(event.target.value)}
              disabled={isRunning || modelOptions.length === 0}
              className={cn(
                "text-xs text-foreground bg-transparent border-0 outline-none",
                "cursor-pointer disabled:cursor-not-allowed",
                "min-w-0 flex-1 truncate",
              )}
              title={modelError || modelSelection?.label || "Model"}
            >
              {modelOptions.length === 0 && (
                <option value="">No models — add an API key →</option>
              )}
              {modelOptions.map((option) => (
                <option
                  key={`${option.provider}:${option.model}`}
                  value={`${option.provider}:${option.model}`}
                >
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => setApiKeyModalOpen(true)}
            title="Manage API keys"
            className={cn(
              "flex items-center justify-center w-7 h-7 rounded-lg shrink-0",
              "bg-secondary/50 hover:bg-secondary border border-border/40",
              "text-muted-foreground hover:text-foreground transition-colors",
            )}
          >
            <KeyRound className="size-3.5" />
          </button>
        </div>
      </div>
      {modelError && (
        <div className="border-b border-border/30 px-4 py-1 text-xs text-destructive">
          {modelError}
        </div>
      )}

      {/* Progress bar */}
      {isRunning && (
        <div className="px-4 py-2 border-b border-border/30">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-muted-foreground truncate max-w-[200px]">{goal}</span>
            <span className="text-muted-foreground tabular-nums shrink-0 ml-2">
              {currentStep}/{maxSteps}
            </span>
          </div>
          <div className="h-px w-full bg-border rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${(currentStep / maxSteps) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full min-h-[200px]">
            <div className="text-center space-y-3">
              <div className="text-4xl">🫐</div>
              <h3 className="text-sm font-semibold">Blueberry AI</h3>
              <p className="text-muted-foreground text-xs max-w-[240px]">
                Ask me anything. I'll browse the web to find answers.
              </p>
              <div className="space-y-1 text-xs text-muted-foreground/60">
                <p>"What's the cheapest flight to London?"</p>
                <p>"Find my important emails"</p>
                <p>"Hi" — I'll just say hello back!</p>
              </div>
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.role === "agent-step" && msg.stepData) {
              const isExpanded = expandedSteps.has(msg.stepData.id);
              return (
                <AgentStepMessage
                  key={msg.id}
                  step={msg.stepData}
                  expanded={isExpanded}
                  onToggle={() => toggleStep(msg.stepData!.id)}
                />
              );
            }

            return (
              <div
                key={msg.id}
                className={cn(
                  "flex",
                  msg.role === "user" ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[85%] text-sm",
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground rounded-xl px-3.5 py-2"
                      : "text-foreground",
                  )}
                >
                  {msg.role === "assistant" ? (
                    <MarkdownMessage content={msg.content} />
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-border/50">
        <div
          className={cn(
            "flex items-end gap-2 rounded-xl px-3 py-2",
            "border border-border/60 focus-within:border-primary/40 focus-within:ring-1 focus-within:ring-primary/10",
            "transition-all",
          )}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRunning ? "Send a message..." : "Ask anything..."}
            className="flex-1 resize-none outline-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground min-h-[20px] max-h-[120px] py-1"
            rows={1}
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim()}
            className={cn(
              "size-7 rounded-lg flex items-center justify-center shrink-0 transition-all",
              "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed",
            )}
          >
            <Send className="size-3.5" />
          </button>
        </div>
        {tokenUsage && tokenUsage.totalTokens > 0 && (
          <div className="mt-1.5 flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground/40 select-none">
            <span title="Input tokens">↑ {formatTokens(tokenUsage.inputTokens)}</span>
            <span>·</span>
            <span title="Output tokens">↓ {formatTokens(tokenUsage.outputTokens)}</span>
            <span>·</span>
            <span>{formatTokens(tokenUsage.totalTokens)} tokens</span>
          </div>
        )}
      </div>

      {pendingApproval && (
        <ApprovalSheet
          request={pendingApproval}
          onResolve={resolveApproval}
        />
      )}

      {pendingScriptReview && !pendingApproval && (
        <ScriptReviewSheet
          request={pendingScriptReview}
          onResolve={resolveScriptReview}
        />
      )}

      <ApiKeyManagerModal
        open={apiKeyModalOpen}
        onClose={() => setApiKeyModalOpen(false)}
        onChanged={() => {
          void refreshModelOptions();
        }}
      />
    </div>
  );
};
