/**
 * McpAgentRunner — Claude-native tool-use based browser agent.
 *
 * Replaces the manual JSON-parsing loop in AgentRunner with Claude's native
 * tool-calling protocol. Every browser action is an MCP-style tool with a JSON
 * Schema definition. Claude calls tools natively; no JSON parsing, no custom
 * self-tracking fields, no prompt engineering for output format.
 *
 * Key improvements over the old runner:
 * - No JSON parsing — Claude returns structured tool_use blocks
 * - No custom working memory — conversation history IS the memory
 * - No action-type JSON in system prompt — tool descriptions carry the API
 * - Fresh page context (URL, text, interactive elements) returned in every
 *   tool result so Claude always has up-to-date state
 * - HITL gate lives inside each tool's execute(), suspending cleanly via Promise
 * - Data collection buckets and CSV generation preserved (dedup across pages)
 */

import { v4 as uuidv4 } from "uuid";
import { generateText, jsonSchema, stepCountIs } from "ai";
import type { LLMClient } from "../../LLMClient";
import type {
  AgentConfig,
  AgentStep,
  AgentStreamUpdate,
  ApprovalDecision,
  ApprovalRequest,
  ScriptReviewRequest,
  ScriptReviewResolution,
  TabStrategy,
  AgentAction,
  ActionResult,
  ExecuteScriptParams,
  CollectedBucketSummary,
} from "../types/AgentTypes";
import {
  classifyActionByText,
  classifyElementLabel,
  describeAction,
  type RiskAssessment,
} from "../core/ApprovalGate";

// ─── Bucket types (data collection dedup) ─────────────────────────────────────

interface CollectedBucket {
  rows: Array<Record<string, unknown>>;
  rowKeys: Set<string>;
  fields: Set<string>;
}

const MAX_BUCKET_ROWS = 500;
const MAX_BUCKET_SAMPLE = 200;

// ─── Gate types ────────────────────────────────────────────────────────────────

interface PendingApproval {
  readonly request: ApprovalRequest;
  readonly resolve: (decision: ApprovalDecision) => void;
}

interface PendingScriptReview {
  readonly request: ScriptReviewRequest;
  readonly resolve: (resolution: ScriptReviewResolution) => void;
}

// ─── Tool result shape returned to Claude ─────────────────────────────────────

interface ToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly currentUrl?: string | null;
  readonly pageText?: string | null;
  readonly interactiveElements?: string | null;
}

// ─── McpAgentRunner ────────────────────────────────────────────────────────────

export class McpAgentRunner {
  private steps: AgentStep[] = [];
  private isRunningFlag = false;
  private abortController: AbortController | null = null;
  private pendingApproval: PendingApproval | null = null;
  private pendingScriptReview: PendingScriptReview | null = null;
  private approveAllForRun = false;
  private stepNum = 0;
  private sessionId = "";
  private collected: Map<string, CollectedBucket> = new Map();
  private lastExtractedBucket: string | null = null;
  private finishAnswer: string | null = null;

  private onUpdate: ((update: AgentStreamUpdate) => void) | null = null;
  private onComplete: ((steps: AgentStep[]) => void) | null = null;
  private onError: ((error: string) => void) | null = null;
  private onApprovalRequired: ((request: ApprovalRequest) => void) | null =
    null;
  private onScriptReviewRequired:
    | ((request: ScriptReviewRequest) => void)
    | null = null;

  constructor(
    private readonly config: AgentConfig,
    private readonly strategy: TabStrategy,
    private readonly llmClient: LLMClient,
  ) {}

  setCallbacks(
    onUpdate: (update: AgentStreamUpdate) => void,
    onComplete: (steps: AgentStep[]) => void,
    onError: (error: string) => void,
  ): void {
    this.onUpdate = onUpdate;
    this.onComplete = onComplete;
    this.onError = onError;
  }

  setApprovalCallback(
    onApprovalRequired: (request: ApprovalRequest) => void,
  ): void {
    this.onApprovalRequired = onApprovalRequired;
  }

  setScriptReviewCallback(
    onScriptReviewRequired: (request: ScriptReviewRequest) => void,
  ): void {
    this.onScriptReviewRequired = onScriptReviewRequired;
  }

  getPendingApproval(): ApprovalRequest | null {
    return this.pendingApproval?.request ?? null;
  }

  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    if (!this.pendingApproval || this.pendingApproval.request.id !== id) {
      return false;
    }
    if (decision === "approve-all") this.approveAllForRun = true;
    const resolve = this.pendingApproval.resolve;
    this.pendingApproval = null;
    resolve(decision);
    return true;
  }

  getPendingScriptReview(): ScriptReviewRequest | null {
    return this.pendingScriptReview?.request ?? null;
  }

  resolveScriptReview(id: string, resolution: ScriptReviewResolution): boolean {
    if (
      !this.pendingScriptReview ||
      this.pendingScriptReview.request.id !== id
    ) {
      return false;
    }
    const resolve = this.pendingScriptReview.resolve;
    this.pendingScriptReview = null;
    resolve(resolution);
    return true;
  }

  abort(): void {
    this.abortController?.abort();
    this.isRunningFlag = false;
    if (this.pendingApproval) {
      const resolve = this.pendingApproval.resolve;
      this.pendingApproval = null;
      resolve("stop");
    }
    if (this.pendingScriptReview) {
      const resolve = this.pendingScriptReview.resolve;
      this.pendingScriptReview = null;
      resolve({ decision: "reject" });
    }
  }

  isActive(): boolean {
    return this.isRunningFlag;
  }

  getSteps(): AgentStep[] {
    return [...this.steps];
  }

  sendUserMessage(_message: string): void {
    // In the tool-use model, mid-run user messages are not supported by generateText.
    // Future enhancement: interrupt and inject a user turn into the conversation.
  }

  // ─── Main entry point ─────────────────────────────────────────────────────────

  async run(goal: string): Promise<void> {
    if (this.isRunningFlag) throw new Error("Agent is already running");

    this.isRunningFlag = true;
    this.steps = [];
    this.approveAllForRun = false;
    this.pendingApproval = null;
    this.pendingScriptReview = null;
    this.abortController = new AbortController();
    this.stepNum = 0;
    this.collected = new Map();
    this.lastExtractedBucket = null;
    this.finishAnswer = null;

    const model = this.llmClient.model;
    if (!model) {
      this.onError?.(
        "No LLM model configured. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env.",
      );
      this.isRunningFlag = false;
      return;
    }

    try {
      // Capture initial page context to seed the prompt
      const initialContext = await this.getPageContext();

      const system = this.buildSystemPrompt();
      const initialPrompt = this.buildInitialPrompt(goal, initialContext);

      await generateText({
        model,
        tools: this.buildTools(),
        stopWhen: stepCountIs(this.config.maxSteps),
        system,
        prompt: initialPrompt,
        abortSignal: this.abortController.signal,
        // temperature not set — Opus 4.7 doesn't support it; models that do
        // use their default (0.0 for tool use is best anyway)
      });

      // If finish was not called explicitly, emit a budget-exhausted finish
      if (this.finishAnswer === null && !this.abortController.signal.aborted) {
        const budgetAnswer = `Reached the step budget after ${this.stepNum} steps.`;
        this.emitFinishUpdate(budgetAnswer, "success");
      }

      this.onComplete?.(this.steps);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.message.includes("aborted"))
      ) {
        // User aborted — complete gracefully with whatever we have
        this.onComplete?.(this.steps);
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[McpAgentRunner] Error:", message);
      this.onError?.(message);
    } finally {
      this.isRunningFlag = false;
      this.abortController = null;
    }
  }

  // ─── Tool definitions ─────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK tool map requires any
  private buildTools(): Record<string, any> {
    return {
      navigate: {
        description:
          "Navigate the browser to a URL. Returns fresh page context (URL, text, elements).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            url: { type: "string", description: "Full URL to navigate to" },
          },
          required: ["url"],
        }),
        execute: async ({ url }: { url: string }) =>
          this.runTool({ type: "navigate", params: { url }, reasoning: `Navigate to ${url}` }),
      },

      click: {
        description:
          "Click an element by CSS selector or screen coordinates. Prefer selectors from the interactive elements list; use x/y for CSP-blocked pages.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector" },
            x: { type: "number", description: "X coordinate (alternative to selector)" },
            y: { type: "number", description: "Y coordinate (alternative to selector)" },
            frame: { type: "string", description: "CSS selector of iframe to target (optional)" },
          },
        }),
        execute: async (params: { selector?: string; x?: number; y?: number; frame?: string }) =>
          this.runTool({ type: "click", params, reasoning: `Click ${params.selector ?? `(${params.x},${params.y})`}` }),
      },

      type: {
        description: "Type text into an input field or contenteditable element.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector of element to type into" },
            text: { type: "string", description: "Text to type" },
            clearFirst: { type: "boolean", description: "Clear existing value before typing (default false)" },
            x: { type: "number", description: "X coordinate (alternative to selector)" },
            y: { type: "number", description: "Y coordinate (alternative to selector)" },
            frame: { type: "string", description: "CSS selector of iframe (optional)" },
          },
          required: ["text"],
        }),
        execute: async (params: { selector?: string; text: string; clearFirst?: boolean; x?: number; y?: number; frame?: string }) =>
          this.runTool({ type: "type", params, reasoning: `Type "${params.text.substring(0, 40)}"` }),
      },

      key: {
        description: "Send a keyboard key (e.g. Enter, Tab, Escape, ArrowDown).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            key: { type: "string", description: 'Key name: Enter, Tab, Escape, ArrowDown, Space, etc.' },
            modifiers: {
              type: "array",
              items: { type: "string", enum: ["control", "shift", "alt", "meta"] },
              description: "Modifier keys to hold",
            },
          },
          required: ["key"],
        }),
        execute: async (params: { key: string; modifiers?: Array<"control" | "shift" | "alt" | "meta"> }) =>
          this.runTool({ type: "key", params, reasoning: `Key ${params.key}` }),
      },

      scroll: {
        description: "Scroll the page up, down, or to a specific element.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            direction: { type: "string", enum: ["up", "down", "to-element"], description: "Scroll direction" },
            amount: { type: "number", description: "Pixels to scroll (default 500)" },
            selector: { type: "string", description: "Scroll to this element (when direction=to-element)" },
          },
          required: ["direction"],
        }),
        execute: async (params: { direction: "up" | "down" | "to-element"; amount?: number; selector?: string }) =>
          this.runTool({ type: "scroll", params, reasoning: `Scroll ${params.direction}` }),
      },

      wait: {
        description: "Wait for a fixed duration in milliseconds.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            duration: { type: "number", description: "Wait time in ms (default 1000, max 10000)" },
          },
        }),
        execute: async (params: { duration?: number }) =>
          this.runTool({ type: "wait", params, reasoning: `Wait ${params.duration ?? 1000}ms` }),
      },

      waitForSelector: {
        description: "Wait until a CSS selector appears in the DOM (useful after navigations or dynamic loads).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector to wait for" },
            timeout: { type: "number", description: "Max wait time in ms (default 10000)" },
            visible: { type: "boolean", description: "Also wait for element to be visible (non-zero size)" },
          },
          required: ["selector"],
        }),
        execute: async (params: { selector: string; timeout?: number; visible?: boolean }) =>
          this.runTool({ type: "waitForSelector", params, reasoning: `Wait for ${params.selector}` }),
      },

      select: {
        description: "Select an option from a <select> dropdown by value or visible text.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector of the <select> element" },
            value: { type: "string", description: "Option value or text to select" },
            frame: { type: "string", description: "CSS selector of iframe (optional)" },
          },
          required: ["selector", "value"],
        }),
        execute: async (params: { selector: string; value: string; frame?: string }) =>
          this.runTool({ type: "select", params, reasoning: `Select "${params.value}" in ${params.selector}` }),
      },

      hover: {
        description: "Hover over an element (triggers CSS :hover state and tooltips).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector" },
            x: { type: "number", description: "X coordinate (alternative to selector)" },
            y: { type: "number", description: "Y coordinate (alternative to selector)" },
          },
        }),
        execute: async (params: { selector?: string; x?: number; y?: number }) =>
          this.runTool({ type: "hover", params, reasoning: `Hover ${params.selector ?? `(${params.x},${params.y})`}` }),
      },

      back: {
        description: "Navigate back in browser history.",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () =>
          this.runTool({ type: "back", params: {}, reasoning: "Go back" }),
      },

      forward: {
        description: "Navigate forward in browser history.",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () =>
          this.runTool({ type: "forward", params: {}, reasoning: "Go forward" }),
      },

      newTab: {
        description: "Open a new browser tab, optionally loading a URL.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            url: { type: "string", description: "URL to load in the new tab (optional)" },
          },
        }),
        execute: async (params: { url?: string }) =>
          this.runTool({ type: "newTab", params, reasoning: `New tab${params.url ? ` → ${params.url}` : ""}` }),
      },

      switchTab: {
        description: "Switch to a different open tab by index (0-based).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            index: { type: "number", description: "Tab index (0 = first tab)" },
          },
          required: ["index"],
        }),
        execute: async (params: { index: number }) =>
          this.runTool({ type: "switchTab", params, reasoning: `Switch to tab ${params.index}` }),
      },

      closeTab: {
        description: "Close a tab by index (default: active tab).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            index: { type: "number", description: "Tab index to close (default: active)" },
          },
        }),
        execute: async (params: { index?: number }) =>
          this.runTool({ type: "closeTab", params, reasoning: `Close tab ${params.index ?? "active"}` }),
      },

      screenshot: {
        description:
          "Capture a screenshot to visually inspect the current page. Use when page text and elements aren't enough to understand the layout.",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => {
          this.stepNum++;
          const action: AgentAction = { type: "screenshot", params: {}, reasoning: "Capture screenshot" };

          this.emitUpdate({
            step: this.stepNum,
            totalSteps: this.config.maxSteps,
            action,
            status: "running",
            sessionId: this.sessionId,
          });

          const screenshotData = await this.strategy.captureScreenshot(800);

          const step: AgentStep = {
            id: uuidv4(),
            timestamp: Date.now(),
            action,
            result: { success: true, data: { screenshot: screenshotData ? "captured" : "failed" } },
            screenshot: screenshotData ?? undefined,
          };
          this.steps.push(step);

          this.emitUpdate({
            step: this.stepNum,
            totalSteps: this.config.maxSteps,
            action,
            status: "success",
            result: step.result,
            screenshot: screenshotData ?? undefined,
            sessionId: this.sessionId,
          });

          // Return page context + screenshot note (base64 too large for tool result text)
          const ctx = await this.getPageContext();
          return {
            success: true,
            screenshotCaptured: screenshotData !== null,
            currentUrl: ctx.currentUrl,
            pageText: ctx.pageText,
            interactiveElements: ctx.interactiveElements,
          };
        },
      },

      extract: {
        description:
          "Extract text, HTML, or attribute value from elements matching a CSS selector.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector for target elements" },
            attribute: {
              type: "string",
              enum: ["text", "html", "value"],
              description: 'What to extract: "text" (default), "html", or "value"',
            },
            name: { type: "string", description: "Key name for the extracted data in the result" },
            frame: { type: "string", description: "CSS selector of iframe (optional)" },
          },
          required: ["selector", "name"],
        }),
        execute: async (params: { selector: string; attribute?: "text" | "html" | "value"; name: string; frame?: string }) =>
          this.runTool({ type: "extract", params, reasoning: `Extract ${params.name} from ${params.selector}` }),
      },

      extractSchema: {
        description:
          "Extract structured tabular data from the page using a field schema. Generates a DOM scraper and collects rows. Use for lists, tables, and repeated items. Results are deduplicated across multiple calls with the same name — ideal for paginated collection.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Bucket name (rows accumulate across calls with the same name — use this for pagination)",
            },
            schema: {
              type: "object",
              description:
                "Map of fieldName → description. Descriptions are instructions for the scraper — be precise. For multi-value cells (e.g. price + change in one cell), describe position: 'ONLY the first decimal — unsigned price. EXCLUDE the signed change and percent.'",
              additionalProperties: { type: "string" },
            },
            limit: {
              type: "number",
              description: "Max rows to extract per call (default 50, max 200)",
            },
            containerHint: {
              type: "string",
              description: "Free-text hint to locate the repeating container on ambiguous pages",
            },
            frame: {
              type: "string",
              description: "CSS selector of iframe to scrape inside (optional)",
            },
          },
          required: ["name", "schema"],
        }),
        execute: async (params: {
          name: string;
          schema: Record<string, string>;
          limit?: number;
          containerHint?: string;
          frame?: string;
        }) => {
          const result = await this.runTool({
            type: "extractSchema",
            params,
            reasoning: `Extract schema "${params.name}"`,
          });

          // Update bucket summary in result for Claude to see dedup progress
          const bucket = this.collected.get(params.name);
          const bucketTotal = bucket?.rows.length ?? 0;

          return {
            ...result,
            bucketTotal,
            bucketName: params.name,
            message: bucket
              ? `Bucket "${params.name}" now has ${bucketTotal} unique rows (fields: ${[...bucket.fields].join(", ")}). Call extractSchema again with the same name after paginating to add more rows.`
              : "No rows collected.",
          };
        },
      },

      executeScript: {
        description:
          "Run custom JavaScript on the page. MANDATORY: user reviews the script before execution. Use for complex form filling, page style injection, or custom extraction that extractSchema cannot handle. Write a self-invoking IIFE that returns a JSON-serializable value.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            script: {
              type: "string",
              description: "JS IIFE starting with (function(){...})(). No fetch, eval, or network calls.",
            },
            description: {
              type: "string",
              description: "Plain English: what the script does and why",
            },
            name: { type: "string", description: "Optional label for the result" },
          },
          required: ["script", "description"],
        }),
        execute: async (params: { script: string; description: string; name?: string }) => {
          this.stepNum++;
          const action: AgentAction = {
            type: "executeScript",
            params: params as ExecuteScriptParams,
            reasoning: params.description.substring(0, 80),
          };

          this.emitUpdate({
            step: this.stepNum,
            totalSteps: this.config.maxSteps,
            action,
            status: "running",
            sessionId: this.sessionId,
          });

          // Mandatory script review gate
          const resolution = await this.requestScriptReview(action);
          if (resolution.decision === "reject") {
            const rejectResult: ActionResult = {
              success: false,
              error: "Script rejected by user",
              recoverable: true,
            };
            this.steps.push({ id: uuidv4(), timestamp: Date.now(), action, result: rejectResult });
            this.emitUpdate({
              step: this.stepNum,
              totalSteps: this.config.maxSteps,
              action,
              status: "error",
              result: rejectResult,
              sessionId: this.sessionId,
            });
            return { success: false, error: "Script rejected by user — try a different approach." };
          }

          const effectiveScript = resolution.approvedScript ?? params.script;
          const effectiveAction: AgentAction = {
            ...action,
            params: { ...params, script: effectiveScript } as ExecuteScriptParams,
          };

          const result = await this.strategy.executeAction(effectiveAction);
          const step: AgentStep = {
            id: uuidv4(),
            timestamp: Date.now(),
            action: effectiveAction,
            result,
          };
          this.steps.push(step);

          this.emitUpdate({
            step: this.stepNum,
            totalSteps: this.config.maxSteps,
            action: effectiveAction,
            status: result.success ? "success" : "error",
            result,
            sessionId: this.sessionId,
          });

          const ctx = await this.getPageContext();
          return this.wrapResult(result, ctx);
        },
      },

      waitForApproval: {
        description:
          "Pause and ask the user to review/approve before continuing. Use before irreversible bulk actions, payments, or sends. Include previewData with what you're about to do.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            reason: { type: "string", description: "Why approval is needed + what will happen next" },
            previewData: {
              type: "object",
              description: "Optional preview of the action (draft content, URLs, counts)",
              additionalProperties: true,
            },
          },
          required: ["reason"],
        }),
        execute: async (params: { reason: string; previewData?: Record<string, unknown> }) => {
          this.stepNum++;
          const action: AgentAction = { type: "waitForApproval", params, reasoning: params.reason.substring(0, 80) };

          this.emitUpdate({
            step: this.stepNum,
            totalSteps: this.config.maxSteps,
            action,
            status: "running",
            sessionId: this.sessionId,
          });

          const screenshot = await this.strategy.captureScreenshot();
          const request: ApprovalRequest = {
            id: uuidv4(),
            sessionId: this.sessionId,
            action,
            reason: params.reason,
            previewData: params.previewData,
            screenshot: screenshot ?? undefined,
            createdAt: Date.now(),
          };

          const decision = await new Promise<ApprovalDecision>((resolve) => {
            this.pendingApproval = { request, resolve };
            this.onApprovalRequired?.(request);
          });

          const result: ActionResult = {
            success: true,
            data: { approved: decision !== "stop", decision },
          };
          this.steps.push({ id: uuidv4(), timestamp: Date.now(), action, result });

          this.emitUpdate({
            step: this.stepNum,
            totalSteps: this.config.maxSteps,
            action,
            status: "success",
            result,
            sessionId: this.sessionId,
          });

          if (decision === "stop") {
            this.abortController?.abort();
            return { approved: false, stopped: true };
          }

          return { approved: true, decision };
        },
      },

      finish: {
        description:
          "Complete the task and deliver the final answer to the user. For data-collection tasks, include a narrative summary — the runner automatically appends the deduplicated CSV from your extraction buckets. NEVER invent data you didn't extract.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            answer: { type: "string", description: "Final answer / summary for the user" },
            bucket: {
              type: "string",
              description:
                "Optional: which extraction bucket to use for CSV (default: the most recently extracted bucket)",
            },
          },
          required: ["answer"],
        }),
        execute: async (params: { answer: string; bucket?: string }) => {
          this.stepNum++;

          // Enrich answer with collected CSV if any
          const enrichedAnswer = this.enrichFinishAnswer(params.answer, params.bucket);
          this.finishAnswer = enrichedAnswer;

          const action: AgentAction = {
            type: "finish",
            params: { ...params, answer: enrichedAnswer },
            reasoning: "Task complete",
          };
          const result: ActionResult = { success: true, data: { completed: true, answer: enrichedAnswer } };

          this.steps.push({ id: uuidv4(), timestamp: Date.now(), action, result });
          this.emitFinishUpdate(enrichedAnswer, "success");

          // Abort the generateText loop cleanly
          this.abortController?.abort();

          return { completed: true, answer: enrichedAnswer };
        },
      },
    };
  }

  // ─── Core tool execution with HITL ───────────────────────────────────────────

  private async runTool(action: AgentAction): Promise<ToolResult> {
    this.stepNum++;

    this.emitUpdate({
      step: this.stepNum,
      totalSteps: this.config.maxSteps,
      action,
      status: "running",
      sessionId: this.sessionId,
    });

    // HITL gate — fires for destructive or explicit approval actions
    const gate = await this.maybeRequestApproval(action);

    if (gate === "stop") {
      const stopResult: ActionResult = { success: true, data: { stopped: true } };
      this.steps.push({ id: uuidv4(), timestamp: Date.now(), action, result: stopResult });
      this.emitUpdate({
        step: this.stepNum,
        totalSteps: this.config.maxSteps,
        action,
        status: "success",
        result: stopResult,
        sessionId: this.sessionId,
      });
      this.abortController?.abort();
      return { success: false, error: "Stopped by user" };
    }

    if (gate === "skip") {
      const skipResult: ActionResult = { success: true, data: { skipped: true } };
      this.steps.push({ id: uuidv4(), timestamp: Date.now(), action, result: skipResult });
      this.emitUpdate({
        step: this.stepNum,
        totalSteps: this.config.maxSteps,
        action,
        status: "success",
        result: skipResult,
        sessionId: this.sessionId,
      });
      const ctx = await this.getPageContext();
      return { success: true, data: { skipped: true }, ...ctx };
    }

    // Execute the action
    const result = await this.strategy.executeAction(action);

    // Track extracted data in buckets
    this.recordExtracted(action, result);

    // Capture screenshot for UI display (not sent to Claude)
    const skipScreenshot = new Set(["extract", "extractSchema", "wait", "waitForSelector", "select", "finish", "waitForApproval", "executeScript"]);
    const screenshot = skipScreenshot.has(action.type)
      ? null
      : await this.strategy.captureScreenshot().catch(() => null);

    const step: AgentStep = {
      id: uuidv4(),
      timestamp: Date.now(),
      action,
      result,
      screenshot: screenshot ?? undefined,
    };
    this.steps.push(step);

    this.emitUpdate({
      step: this.stepNum,
      totalSteps: this.config.maxSteps,
      action,
      status: result.success ? "success" : "error",
      result,
      screenshot: screenshot ?? undefined,
      sessionId: this.sessionId,
    });

    // Return result + fresh page context so Claude always has up-to-date state
    const ctx = await this.getPageContext();
    return this.wrapResult(result, ctx);
  }

  // ─── HITL approval gate ───────────────────────────────────────────────────────

  private async maybeRequestApproval(
    action: AgentAction,
  ): Promise<ApprovalDecision | null> {
    if (this.approveAllForRun && action.type !== "waitForApproval") return null;

    const risk = await this.assessRisk(action);
    if (!risk.destructive) return null;

    const label = await this.resolveLabel(action);
    const screenshot = await this.strategy.captureScreenshot();

    const request: ApprovalRequest = {
      id: uuidv4(),
      sessionId: this.sessionId,
      action,
      reason: this.buildApprovalReason(action, risk, label),
      matchedKeyword: risk.matchedKeyword,
      elementLabel: label ?? undefined,
      screenshot: screenshot ?? undefined,
      createdAt: Date.now(),
    };

    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingApproval = { request, resolve };
      this.onApprovalRequired?.(request);
    });
  }

  private async requestScriptReview(
    action: AgentAction,
  ): Promise<ScriptReviewResolution> {
    const params = action.params as ExecuteScriptParams;
    const screenshot = await this.strategy.captureScreenshot();
    const request: ScriptReviewRequest = {
      id: uuidv4(),
      sessionId: this.sessionId,
      script: params.script,
      description: params.description,
      name: params.name,
      screenshot: screenshot ?? undefined,
      createdAt: Date.now(),
    };

    return new Promise<ScriptReviewResolution>((resolve) => {
      this.pendingScriptReview = { request, resolve };
      this.onScriptReviewRequired?.(request);
    });
  }

  private async assessRisk(action: AgentAction): Promise<RiskAssessment> {
    const textBased = classifyActionByText(action);
    if (textBased.destructive) return textBased;
    if (this.strategy.getActionLabel) {
      try {
        const label = await this.strategy.getActionLabel(action);
        return classifyElementLabel(action, label);
      } catch {
        // safe fallback
      }
    }
    return { destructive: false };
  }

  private async resolveLabel(action: AgentAction): Promise<string | null> {
    if (!this.strategy.getActionLabel) return null;
    try {
      return await this.strategy.getActionLabel(action);
    } catch {
      return null;
    }
  }

  private buildApprovalReason(
    action: AgentAction,
    risk: RiskAssessment,
    label: string | null,
  ): string {
    const summary = describeAction(action);
    if (risk.matchedKeyword) {
      const where =
        risk.source === "elementLabel"
          ? "target element"
          : risk.source === "reasoning"
            ? "agent reasoning"
            : "action params";
      const labelHint = label ? ` Target reads: "${label}"` : "";
      return `${summary} — flagged by keyword "${risk.matchedKeyword}" in ${where}.${labelHint}`;
    }
    return summary;
  }

  // ─── Bucket accumulation & CSV generation ────────────────────────────────────

  private recordExtracted(action: AgentAction, result: ActionResult): void {
    if (!result.success) return;
    const data = result.data as Record<string, unknown> | null;
    if (!data) return;

    if (action.type === "extractSchema") {
      const params = action.params as { name?: string };
      const name = params.name?.trim();
      if (!name) return;
      const rows = data[name];
      if (Array.isArray(rows)) {
        this.recordInBucket(name, rows);
        this.lastExtractedBucket = name;
      }
    }

    if (action.type === "extract") {
      const params = action.params as { name?: string };
      const name = params.name?.trim();
      if (!name) return;
      const value = data[name];
      if (Array.isArray(value)) {
        this.recordInBucket(name, value);
        this.lastExtractedBucket = name;
      }
    }
  }

  private recordInBucket(name: string, rows: ReadonlyArray<unknown>): void {
    let bucket = this.collected.get(name);
    if (!bucket) {
      bucket = { rows: [], rowKeys: new Set(), fields: new Set() };
      this.collected.set(name, bucket);
    }
    for (const row of rows) {
      if (bucket.rows.length >= MAX_BUCKET_ROWS) break;
      const normalized = this.normalizeRow(row);
      if (!normalized) continue;
      const key = this.rowKey(normalized);
      if (bucket.rowKeys.has(key)) continue;
      bucket.rowKeys.add(key);
      bucket.rows.push(normalized);
      for (const f of Object.keys(normalized)) bucket.fields.add(f);
    }
  }

  private normalizeRow(row: unknown): Record<string, unknown> | null {
    if (row === null || row === undefined) return null;
    if (typeof row === "object" && !Array.isArray(row)) return row as Record<string, unknown>;
    return { value: row };
  }

  private rowKey(row: Record<string, unknown>): string {
    return Object.keys(row)
      .sort()
      .map((k) => `${k}=${String(row[k] ?? "").trim().toLowerCase()}`)
      .join("|");
  }

  private enrichFinishAnswer(narrative: string, explicitBucket?: string): string {
    if (this.collected.size === 0) return narrative;

    const canonicalName = this.pickCanonicalBucket(explicitBucket);
    if (!canonicalName) return narrative;

    const canonical = this.collected.get(canonicalName);
    if (!canonical || canonical.rows.length === 0) return narrative;

    // Strip any model-written CSV from the narrative and replace with ours
    const cleanNarrative = narrative
      .replace(/```csv[\s\S]*?```/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const csvSection = this.bucketToCsv(canonicalName, canonical);
    if (!csvSection) return narrative;

    const dropped = [...this.collected.entries()]
      .filter(([n, b]) => n !== canonicalName && b.rows.length > 0)
      .map(([n, b]) => `${n} (${b.rows.length})`);
    const droppedNote =
      dropped.length > 0
        ? `\n\n*(Older buckets dropped: ${dropped.join(", ")})*`
        : "";

    return (
      [
        cleanNarrative ||
          `Collected ${canonical.rows.length} rows in bucket "${canonicalName}".`,
        csvSection,
      ]
        .join("\n\n")
        .trim() + droppedNote
    );
  }

  private pickCanonicalBucket(explicit: string | undefined): string | null {
    if (
      explicit &&
      this.collected.has(explicit) &&
      (this.collected.get(explicit)?.rows.length ?? 0) > 0
    ) {
      return explicit;
    }
    if (
      this.lastExtractedBucket &&
      this.collected.has(this.lastExtractedBucket) &&
      (this.collected.get(this.lastExtractedBucket)?.rows.length ?? 0) > 0
    ) {
      return this.lastExtractedBucket;
    }
    let fallback: string | null = null;
    for (const [name, bucket] of this.collected) {
      if (bucket.rows.length > 0) fallback = name;
    }
    return fallback;
  }

  private bucketToCsv(name: string, bucket: CollectedBucket): string {
    if (bucket.rows.length === 0) return "";
    const fields = [...bucket.fields];
    if (fields.length === 0) return "";
    const sampleRows = bucket.rows.slice(0, MAX_BUCKET_SAMPLE);
    const header = fields.map(csvEscape).join(",");
    const lines = sampleRows.map((row) =>
      fields.map((f) => csvEscape(stringifyCell(row[f]))).join(","),
    );
    return `${name} (${bucket.rows.length} rows):\n\`\`\`csv\n${header}\n${lines.join("\n")}\n\`\`\``;
  }

  getSummaryOfCollected(): ReadonlyArray<CollectedBucketSummary> {
    const out: CollectedBucketSummary[] = [];
    for (const [name, bucket] of this.collected) {
      out.push({
        name,
        count: bucket.rows.length,
        sample: bucket.rows.slice(0, MAX_BUCKET_SAMPLE),
        fields: [...bucket.fields],
      });
    }
    return out;
  }

  // ─── Page context ─────────────────────────────────────────────────────────────

  private async getPageContext(): Promise<{
    currentUrl: string | null;
    pageText: string | null;
    interactiveElements: string | null;
  }> {
    const [currentUrl, pageText, ctx] = await Promise.all([
      this.strategy.getCurrentUrl().catch(() => null),
      this.strategy.getPageText().catch(() => null),
      this.strategy.getActiveContext("", []).catch(() => null),
    ]);
    return {
      currentUrl,
      pageText: pageText ? pageText.substring(0, 2500) : null,
      interactiveElements: ctx?.interactiveElements
        ? ctx.interactiveElements.substring(0, 1800)
        : null,
    };
  }

  private wrapResult(result: ActionResult, ctx: { currentUrl: string | null; pageText: string | null; interactiveElements: string | null }): ToolResult {
    return {
      success: result.success,
      data: result.success ? result.data : undefined,
      error: result.success ? undefined : result.error,
      currentUrl: ctx.currentUrl,
      pageText: ctx.pageText,
      interactiveElements: ctx.interactiveElements,
    };
  }

  // ─── System prompt & initial message ─────────────────────────────────────────

  private buildSystemPrompt(): string {
    return `You are Blueberry AI, a browser automation agent. You drive a real Electron browser using the browser tools available to you.

CAPABILITIES
You have tools for navigation, clicking, typing, scrolling, extracting data, taking screenshots, and more. Each tool returns the current page URL, text, and interactive elements so you always have fresh context.

DATA COLLECTION (extractSchema)
- Use extractSchema with a stable bucket name (e.g. "stocks"). Rows accumulate and deduplicate across calls with the same name — ideal for pagination.
- After each call, the result tells you how many unique rows are in the bucket.
- Navigate/paginate, then call extractSchema again with the SAME name to add more rows.
- Call finish when you've met your criteria. The runner automatically appends the canonical CSV to your answer — do NOT write CSV yourself.
- Schema field descriptions are instructions to a scraper-writing LLM. Be precise. For multi-value cells: "ONLY the first decimal — unsigned price. EXCLUDE the signed change and percent."

INTERACTIVE ELEMENTS
The "interactiveElements" field in each tool result lists exact CSS selectors. Prefer these over guessed selectors.

HUMAN APPROVAL
Destructive elements (Send, Pay, Delete, Confirm) automatically trigger an approval gate before they run — just choose the action. For intentional review points, use the waitForApproval tool.

SIGN-IN WALLS
Use waitForApproval to ask the user to log in, then continue after they approve.

COMPLETION — MANDATORY
You MUST call the finish tool to end every session, without exception. Never generate a plain text response as your final action — always use a tool call. If you have an answer ready, call finish(answer=...) immediately. If you hit a wall or run out of ideas, call finish and honestly describe what happened. There is no valid reason to output text without also calling a tool.

Always use browser evidence only — never answer from training knowledge when the task involves live web data.`;
  }

  private buildInitialPrompt(
    goal: string,
    ctx: { currentUrl: string | null; pageText: string | null; interactiveElements: string | null },
  ): string {
    const parts: string[] = [`Task: ${goal}`];

    if (ctx.currentUrl) {
      parts.push(`Current URL: ${ctx.currentUrl}`);
    }

    if (ctx.interactiveElements) {
      parts.push(`\nInteractive elements (use these exact selectors):\n${ctx.interactiveElements}`);
    }

    if (ctx.pageText) {
      const excerpt = ctx.pageText.substring(0, 1800);
      parts.push(`\nPage text:\n${excerpt}`);
    }

    parts.push("\nStart working on the task. Call finish when done.");

    return parts.join("\n");
  }

  // ─── Emit helpers ─────────────────────────────────────────────────────────────

  private emitUpdate(update: AgentStreamUpdate): void {
    this.onUpdate?.(update);
  }

  private emitFinishUpdate(answer: string, status: AgentStreamUpdate["status"]): void {
    this.emitUpdate({
      step: this.stepNum,
      totalSteps: this.config.maxSteps,
      action: {
        type: "finish",
        params: { answer },
        reasoning: "Task complete",
      },
      status,
      result: { success: true, data: { completed: true, answer } },
      sessionId: this.sessionId,
    });
  }
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function csvEscape(value: string): string {
  if (value === "") return "";
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
