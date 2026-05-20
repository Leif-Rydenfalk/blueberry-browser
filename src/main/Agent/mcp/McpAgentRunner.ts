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
import { generateText, hasToolCall, jsonSchema, stepCountIs } from "ai";
import type { LLMClient } from "../../LLMClient";
import type {
  AgentConfig,
  AgentStep,
  AgentStreamUpdate,
  ApprovalDecision,
  ApprovalRequest,
  LoginDecision,
  LoginRequiredRequest,
  ScriptReviewRequest,
  ScriptReviewResolution,
  TabStrategy,
  AgentAction,
  ActionResult,
  ExecuteScriptParams,
  CollectedBucketSummary,
  ConversationTurn,
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

interface PendingLogin {
  readonly request: LoginRequiredRequest;
  readonly resolve: (decision: LoginDecision) => void;
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
  private pendingLogin: PendingLogin | null = null;
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
  private onLoginRequired: ((request: LoginRequiredRequest) => void) | null =
    null;

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

  setLoginCallback(
    onLoginRequired: (request: LoginRequiredRequest) => void,
  ): void {
    this.onLoginRequired = onLoginRequired;
  }

  getPendingLogin(): LoginRequiredRequest | null {
    return this.pendingLogin?.request ?? null;
  }

  resolveLogin(id: string, decision: LoginDecision): boolean {
    if (!this.pendingLogin || this.pendingLogin.request.id !== id) {
      return false;
    }
    const resolve = this.pendingLogin.resolve;
    this.pendingLogin = null;
    resolve(decision);
    return true;
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
    if (this.pendingLogin) {
      const resolve = this.pendingLogin.resolve;
      this.pendingLogin = null;
      resolve("stop");
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

  async run(
    goal: string,
    conversationHistory?: ReadonlyArray<ConversationTurn>,
  ): Promise<void> {
    if (this.isRunningFlag) throw new Error("Agent is already running");

    this.isRunningFlag = true;
    this.steps = [];
    // Auto-approve mode: MCP/headless runs never hang on human approval gates
    this.approveAllForRun = this.config.autoApprove ?? false;
    this.pendingApproval = null;
    this.pendingScriptReview = null;
    this.pendingLogin = null;
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
      const initialPrompt = this.buildInitialPrompt(
        goal,
        initialContext,
        conversationHistory,
      );

      await generateText({
        model,
        tools: this.buildTools(),
        // hasToolCall("finish") is the load-bearing stop — abort() from inside
        // the finish tool's execute() doesn't reliably terminate the SDK's
        // multi-step loop, so the model would keep emitting tool calls and the
        // MCP delegate_task promise would never resolve.
        stopWhen: [stepCountIs(this.config.maxSteps), hasToolCall("finish")],
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
          this.runTool({
            type: "navigate",
            params: { url },
            reasoning: `Navigate to ${url}`,
          }),
      },

      click: {
        description:
          "Click an element by CSS selector or screen coordinates. Prefer selectors from the interactive elements list; use x/y for CSP-blocked pages.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector" },
            x: {
              type: "number",
              description: "X coordinate (alternative to selector)",
            },
            y: {
              type: "number",
              description: "Y coordinate (alternative to selector)",
            },
            frame: {
              type: "string",
              description: "CSS selector of iframe to target (optional)",
            },
          },
        }),
        execute: async (params: {
          selector?: string;
          x?: number;
          y?: number;
          frame?: string;
        }) =>
          this.runTool({
            type: "click",
            params,
            reasoning: `Click ${params.selector ?? `(${params.x},${params.y})`}`,
          }),
      },

      type: {
        description:
          "Type text into an input field or contenteditable element.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector of element to type into",
            },
            text: { type: "string", description: "Text to type" },
            clearFirst: {
              type: "boolean",
              description: "Clear existing value before typing (default false)",
            },
            x: {
              type: "number",
              description: "X coordinate (alternative to selector)",
            },
            y: {
              type: "number",
              description: "Y coordinate (alternative to selector)",
            },
            frame: {
              type: "string",
              description: "CSS selector of iframe (optional)",
            },
          },
          required: ["text"],
        }),
        execute: async (params: {
          selector?: string;
          text: string;
          clearFirst?: boolean;
          x?: number;
          y?: number;
          frame?: string;
        }) =>
          this.runTool({
            type: "type",
            params,
            reasoning: `Type "${params.text.substring(0, 40)}"`,
          }),
      },

      key: {
        description:
          "Send a keyboard key (e.g. Enter, Tab, Escape, ArrowDown).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            key: {
              type: "string",
              description:
                "Key name: Enter, Tab, Escape, ArrowDown, Space, etc.",
            },
            modifiers: {
              type: "array",
              items: {
                type: "string",
                enum: ["control", "shift", "alt", "meta"],
              },
              description: "Modifier keys to hold",
            },
          },
          required: ["key"],
        }),
        execute: async (params: {
          key: string;
          modifiers?: Array<"control" | "shift" | "alt" | "meta">;
        }) =>
          this.runTool({ type: "key", params, reasoning: `Key ${params.key}` }),
      },

      scroll: {
        description: "Scroll the page up, down, or to a specific element.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            direction: {
              type: "string",
              enum: ["up", "down", "to-element"],
              description: "Scroll direction",
            },
            amount: {
              type: "number",
              description: "Pixels to scroll (default 500)",
            },
            selector: {
              type: "string",
              description: "Scroll to this element (when direction=to-element)",
            },
          },
          required: ["direction"],
        }),
        execute: async (params: {
          direction: "up" | "down" | "to-element";
          amount?: number;
          selector?: string;
        }) =>
          this.runTool({
            type: "scroll",
            params,
            reasoning: `Scroll ${params.direction}`,
          }),
      },

      wait: {
        description: "Wait for a fixed duration in milliseconds.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            duration: {
              type: "number",
              description: "Wait time in ms (default 1000, max 10000)",
            },
          },
        }),
        execute: async (params: { duration?: number }) =>
          this.runTool({
            type: "wait",
            params,
            reasoning: `Wait ${params.duration ?? 1000}ms`,
          }),
      },

      waitForSelector: {
        description:
          "Wait until a CSS selector appears in the DOM (useful after navigations or dynamic loads).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector to wait for",
            },
            timeout: {
              type: "number",
              description: "Max wait time in ms (default 10000)",
            },
            visible: {
              type: "boolean",
              description:
                "Also wait for element to be visible (non-zero size)",
            },
          },
          required: ["selector"],
        }),
        execute: async (params: {
          selector: string;
          timeout?: number;
          visible?: boolean;
        }) =>
          this.runTool({
            type: "waitForSelector",
            params,
            reasoning: `Wait for ${params.selector}`,
          }),
      },

      select: {
        description:
          "Select an option from a <select> dropdown by value or visible text.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector of the <select> element",
            },
            value: {
              type: "string",
              description: "Option value or text to select",
            },
            frame: {
              type: "string",
              description: "CSS selector of iframe (optional)",
            },
          },
          required: ["selector", "value"],
        }),
        execute: async (params: {
          selector: string;
          value: string;
          frame?: string;
        }) =>
          this.runTool({
            type: "select",
            params,
            reasoning: `Select "${params.value}" in ${params.selector}`,
          }),
      },

      hover: {
        description:
          "Hover over an element (triggers CSS :hover state and tooltips).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector" },
            x: {
              type: "number",
              description: "X coordinate (alternative to selector)",
            },
            y: {
              type: "number",
              description: "Y coordinate (alternative to selector)",
            },
          },
        }),
        execute: async (params: {
          selector?: string;
          x?: number;
          y?: number;
        }) =>
          this.runTool({
            type: "hover",
            params,
            reasoning: `Hover ${params.selector ?? `(${params.x},${params.y})`}`,
          }),
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
          this.runTool({
            type: "forward",
            params: {},
            reasoning: "Go forward",
          }),
      },

      newTab: {
        description: "Open a new browser tab, optionally loading a URL.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "URL to load in the new tab (optional)",
            },
          },
        }),
        execute: async (params: { url?: string }) =>
          this.runTool({
            type: "newTab",
            params,
            reasoning: `New tab${params.url ? ` → ${params.url}` : ""}`,
          }),
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
          this.runTool({
            type: "switchTab",
            params,
            reasoning: `Switch to tab ${params.index}`,
          }),
      },

      closeTab: {
        description: "Close a tab by index (default: active tab).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            index: {
              type: "number",
              description: "Tab index to close (default: active)",
            },
          },
        }),
        execute: async (params: { index?: number }) =>
          this.runTool({
            type: "closeTab",
            params,
            reasoning: `Close tab ${params.index ?? "active"}`,
          }),
      },

      screenshot: {
        description:
          "Capture a screenshot to visually inspect the current page. Use when page text and elements aren't enough to understand the layout.",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => {
          this.stepNum++;
          const action: AgentAction = {
            type: "screenshot",
            params: {},
            reasoning: "Capture screenshot",
          };

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
            result: {
              success: true,
              data: { screenshot: screenshotData ? "captured" : "failed" },
            },
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
            selector: {
              type: "string",
              description: "CSS selector for target elements",
            },
            attribute: {
              type: "string",
              enum: ["text", "html", "value"],
              description:
                'What to extract: "text" (default), "html", or "value"',
            },
            name: {
              type: "string",
              description: "Key name for the extracted data in the result",
            },
            frame: {
              type: "string",
              description: "CSS selector of iframe (optional)",
            },
          },
          required: ["selector", "name"],
        }),
        execute: async (params: {
          selector: string;
          attribute?: "text" | "html" | "value";
          name: string;
          frame?: string;
        }) =>
          this.runTool({
            type: "extract",
            params,
            reasoning: `Extract ${params.name} from ${params.selector}`,
          }),
      },

      extractSchema: {
        description:
          "Extract structured tabular data from the page using a field schema. Generates a DOM scraper and collects rows. Use for lists, tables, and repeated items. Results are deduplicated across multiple calls with the same name — ideal for paginated collection.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Bucket name (rows accumulate across calls with the same name — use this for pagination)",
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
              description:
                "Free-text hint to locate the repeating container on ambiguous pages",
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

          const message = bucketTotal > 0
            ? `Bucket "${params.name}" now has ${bucketTotal} unique rows (fields: ${[...bucket!.fields].join(", ")}). ✓ Stage complete — continue to the next stage.`
            : `⚠ ZERO ROWS collected for "${params.name}". This stage is NOT complete. DO NOT proceed to the next pipeline stage. You must retry:\n  1. Call screenshot to see what is currently on the page\n  2. If you see a sign-in / login page: call loginRequired({app:"[the app]", instructions:"Sign in and click I'm signed in.", qrLogin:false})\n  3. Wait 2s then retry extractSchema with a looser schema or different containerHint\n  4. Try scroll(down) to load content then retry\n  Only skip this stage after 3+ failed attempts — and note the failure explicitly in your final answer.`;

          return {
            ...result,
            bucketTotal,
            bucketName: params.name,
            stageComplete: bucketTotal > 0,
            message,
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
              description:
                "JS IIFE starting with (function(){...})(). No fetch, eval, or network calls.",
            },
            description: {
              type: "string",
              description: "Plain English: what the script does and why",
            },
            name: {
              type: "string",
              description: "Optional label for the result",
            },
          },
          required: ["script", "description"],
        }),
        execute: async (params: {
          script: string;
          description: string;
          name?: string;
        }) => {
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

          // Script review gate — skipped when always-allow or auto-approve is set
          const resolution = (this.config.alwaysAllowScripts || this.config.autoApprove)
            ? { decision: "approve" as const, approvedScript: params.script }
            : await this.requestScriptReview(action);
          if (resolution.decision === "reject") {
            const rejectResult: ActionResult = {
              success: false,
              error: "Script rejected by user",
              recoverable: true,
            };
            this.steps.push({
              id: uuidv4(),
              timestamp: Date.now(),
              action,
              result: rejectResult,
            });
            this.emitUpdate({
              step: this.stepNum,
              totalSteps: this.config.maxSteps,
              action,
              status: "error",
              result: rejectResult,
              sessionId: this.sessionId,
            });
            return {
              success: false,
              error: "Script rejected by user — try a different approach.",
            };
          }

          const effectiveScript = resolution.approvedScript ?? params.script;
          const effectiveAction: AgentAction = {
            ...action,
            params: {
              ...params,
              script: effectiveScript,
            } as ExecuteScriptParams,
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

      loginRequired: {
        description:
          "Block the run until the user signs in. Call this EXACTLY ONCE when you land on a login / sign-in / QR-code page. The tool returns only after the user clicks 'I'm signed in' (or skip/stop) in the sidebar — there is no timeout, no polling, no retry loop. After it resolves, take a screenshot to confirm you are past the login wall, then continue the task. Do NOT call wait() or screenshot() in a loop waiting for login — call this tool and let the human drive it.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            app: {
              type: "string",
              description:
                "App/service name (e.g. 'WhatsApp Web', 'Gmail', 'Slack'). Shown in the sidebar UI.",
            },
            instructions: {
              type: "string",
              description:
                "Plain instructions the user needs to follow (e.g. 'Scan the QR code on screen with WhatsApp on your phone, then click I am signed in.').",
            },
            qrLogin: {
              type: "boolean",
              description:
                "true if this is a QR-code / phone-pair login, false for password/OAuth.",
            },
            url: {
              type: "string",
              description:
                "URL of the login page (optional — defaults to current tab URL).",
            },
          },
          required: ["app", "instructions"],
        }),
        execute: async (params: {
          app: string;
          instructions: string;
          qrLogin?: boolean;
          url?: string;
        }) => {
          this.stepNum++;
          const action: AgentAction = {
            type: "loginRequired",
            params,
            reasoning: `Sign-in required for ${params.app}`,
          };

          this.emitUpdate({
            step: this.stepNum,
            totalSteps: this.config.maxSteps,
            action,
            status: "running",
            sessionId: this.sessionId,
          });

          // Auto-approve mode (MCP delegations): we still gate on login because
          // sign-in requires the human at the desktop — a remote agent can't
          // type a password or scan a QR. Returning "signed-in" without user
          // action would just loop forever on the next screenshot.

          const currentUrl = await this.strategy.getCurrentUrl().catch(() => null);
          const screenshot = await this.strategy.captureScreenshot();
          const request: LoginRequiredRequest = {
            id: uuidv4(),
            sessionId: this.sessionId,
            app: params.app,
            instructions: params.instructions,
            qrLogin: params.qrLogin ?? false,
            url: params.url ?? currentUrl,
            screenshot: screenshot ?? undefined,
            createdAt: Date.now(),
          };

          const decision = await new Promise<LoginDecision>((resolve) => {
            this.pendingLogin = { request, resolve };
            this.onLoginRequired?.(request);
          });

          const result: ActionResult =
            decision === "stop"
              ? {
                  success: false,
                  error: "User stopped at login wall",
                  recoverable: false,
                }
              : {
                  success: true,
                  data: { decision, signedIn: decision === "signed-in" },
                };
          this.steps.push({
            id: uuidv4(),
            timestamp: Date.now(),
            action,
            result,
          });

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
            return { signedIn: false, stopped: true };
          }

          // Return fresh page context so Claude sees the post-login page in
          // the next tool result.
          const ctx = await this.getPageContext();
          return {
            signedIn: decision === "signed-in",
            decision,
            ...ctx,
            message:
              decision === "signed-in"
                ? `User signaled signed-in. Take a screenshot to confirm the login wall is gone, then continue with the task. If the login wall is still visible, call loginRequired again with a clearer instruction.`
                : `User skipped sign-in for ${params.app}. Move on to the next stage without this app's data.`,
          };
        },
      },

      waitForApproval: {
        description:
          "Pause and ask the user to review/approve before continuing. Use before irreversible bulk actions, payments, or sends. Include previewData with what you're about to do.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Why approval is needed + what will happen next",
            },
            previewData: {
              type: "object",
              description:
                "Optional preview of the action (draft content, URLs, counts)",
              additionalProperties: true,
            },
          },
          required: ["reason"],
        }),
        execute: async (params: {
          reason: string;
          previewData?: Record<string, unknown>;
        }) => {
          this.stepNum++;
          const action: AgentAction = {
            type: "waitForApproval",
            params,
            reasoning: params.reason.substring(0, 80),
          };

          this.emitUpdate({
            step: this.stepNum,
            totalSteps: this.config.maxSteps,
            action,
            status: "running",
            sessionId: this.sessionId,
          });

          // Auto-approve: MCP/headless runs never hang on human gates
          if (this.config.autoApprove) {
            const autoResult: ActionResult = {
              success: true,
              data: { approved: true, decision: "approve-all", autoApproved: true },
            };
            this.steps.push({ id: uuidv4(), timestamp: Date.now(), action, result: autoResult });
            this.emitUpdate({
              step: this.stepNum,
              totalSteps: this.config.maxSteps,
              action,
              status: "success",
              result: autoResult,
              sessionId: this.sessionId,
            });
            return { approved: true, decision: "approve-all", autoApproved: true };
          }

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
          this.steps.push({
            id: uuidv4(),
            timestamp: Date.now(),
            action,
            result,
          });

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
            answer: {
              type: "string",
              description: "Final answer / summary for the user",
            },
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
          const enrichedAnswer = this.enrichFinishAnswer(
            params.answer,
            params.bucket,
          );
          this.finishAnswer = enrichedAnswer;

          const action: AgentAction = {
            type: "finish",
            params: { ...params, answer: enrichedAnswer },
            reasoning: "Task complete",
          };
          const result: ActionResult = {
            success: true,
            data: { completed: true, answer: enrichedAnswer },
          };

          this.steps.push({
            id: uuidv4(),
            timestamp: Date.now(),
            action,
            result,
          });
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
      const stopResult: ActionResult = {
        success: true,
        data: { stopped: true },
      };
      this.steps.push({
        id: uuidv4(),
        timestamp: Date.now(),
        action,
        result: stopResult,
      });
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
      const skipResult: ActionResult = {
        success: true,
        data: { skipped: true },
      };
      this.steps.push({
        id: uuidv4(),
        timestamp: Date.now(),
        action,
        result: skipResult,
      });
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
    const skipScreenshot = new Set([
      "extract",
      "extractSchema",
      "wait",
      "waitForSelector",
      "select",
      "finish",
      "waitForApproval",
      "loginRequired",
      "executeScript",
    ]);
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
    if (typeof row === "object" && !Array.isArray(row))
      return row as Record<string, unknown>;
    return { value: row };
  }

  private rowKey(row: Record<string, unknown>): string {
    return Object.keys(row)
      .sort()
      .map(
        (k) =>
          `${k}=${String(row[k] ?? "")
            .trim()
            .toLowerCase()}`,
      )
      .join("|");
  }

  private enrichFinishAnswer(
    narrative: string,
    explicitBucket?: string,
  ): string {
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

  private wrapResult(
    result: ActionResult,
    ctx: {
      currentUrl: string | null;
      pageText: string | null;
      interactiveElements: string | null;
    },
  ): ToolResult {
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

────────────────────────────────────────────────────────────
LANGUAGE — SVENSKA / ENGLISH
────────────────────────────────────────────────────────────
You understand and act on instructions in both Swedish and English. Common Swedish terms:
- "skicka" / "skicka iväg" = send
- "skicka mail" / "skicka mejl" / "maila" = send email
- "till" = to (recipient)
- "öppna" / "öppna upp" = open
- "läs" / "kolla" = read / check
- "sök" / "hitta" = search / find
- "svara" / "svara på" = reply / reply to
- "istället" = instead
- "isåfall" / "i så fall" = in that case
- "gmail inkorg" / "inkorgen" = gmail inbox
- "det" / "den" = it / that (refers to something mentioned earlier)
- "bifoga" = attach
- "ämne" = subject
- "mottagare" = recipient

When the user says "skicka det till X" or "send it to X" — "det/it" refers to what was discussed earlier in the conversation (e.g. a previously drafted message, a found piece of information). Use the conversation history to resolve what "it" refers to.

────────────────────────────────────────────────────────────
INTERACTION PRIORITY — CRITICAL
────────────────────────────────────────────────────────────
1. ALWAYS prefer native browser interactions: navigate, click, type, scroll, key, select.
2. Use executeScript ONLY as a last resort — when multiple native attempts have failed and you genuinely cannot proceed otherwise. Browsers flag scripts and the user must approve them every time.
3. If you find yourself reaching for executeScript first, STOP and ask: can I click/type/navigate to achieve this? Almost always the answer is yes.
4. Never use executeScript for tasks achievable through: typing into an input field, clicking a button, selecting a dropdown value, pressing Enter/Tab, or standard form submission.

────────────────────────────────────────────────────────────
CAPABILITIES
────────────────────────────────────────────────────────────
You have tools for navigation, clicking, typing, scrolling, extracting data, taking screenshots, and more. Each tool returns the current page URL, text, and interactive elements so you always have fresh context.

────────────────────────────────────────────────────────────
THOROUGHNESS AND PERSISTENCE — CORE OPERATING PRINCIPLES
────────────────────────────────────────────────────────────
You are a thorough, persistent agent. Lazy shortcuts lead to wrong answers and missed data.

SCROLLING — MANDATORY for any read/summarize/extract task:
- Always scroll DOWN after a page loads to reveal content below the fold.
- Always scroll back UP to confirm nothing was missed at the top.
- For inboxes, feeds, and lists: scroll through the ENTIRE visible list before extracting.
- If a page has a scrollable container (e.g. email list, calendar day column), scroll WITHIN that container.
- Never report "nothing found" or "no events" without first scrolling the full page.

PAGINATION — MANDATORY when more data may exist:
- After extracting from any list, look for pagination indicators: "1-50 of 200", "Next ›", "Page 2", "Load more".
- If pagination exists: navigate to the next page and extract again with the SAME bucket name.
- Continue until you have enough data for the task or reach the last page.
- For Gmail: the "1-50 of N" counter is at the top-right of the inbox. If N > 50, check page 2.
- For Google Calendar: navigate forward in time to check if events exist beyond the current view.

SCREENSHOT VERIFICATION — MANDATORY before and after irreversible actions:
- Before sending any email/message: screenshot to verify To, Subject, and Body are all correct.
- After sending: screenshot to confirm the "sent" confirmation appeared.
- After navigating to a new page: screenshot if the page text doesn't clearly tell you what loaded.
- When extractSchema returns 0 rows: screenshot before retrying to understand why.

RETRYING — NEVER give up after one failure:
- If a click does nothing: try again with a different selector or coordinates.
- If a page loads blank: wait(2000) then screenshot.
- If sign-in is required: call loginRequired ONCE (see SIGN-IN WALLS section) — do not loop with wait()/screenshot().
- If extractSchema returns 0 rows: retry at least 3 times with different approaches before skipping.
- If you cannot find an element: scroll to find it, try a different selector, try coordinates.

COMPLETENESS — DO THE FULL JOB:
- Never summarize the first screenful and call it done.
- Never write "please check manually" when you can actually check it yourself.
- Never skip a required step because it seems hard or uncertain.
- If a task says "check Gmail, Slack, and Calendar" — you check all three, fully, before finishing.

IMPATIENT PERSISTENCE — MOVE FAST, FINISH EVERYTHING:
- Never wait for things to settle. If a page is loaded enough to interact with, interact.
- When something fails: immediately try the next strategy. Don't pause, don't explain — just try something else.
- Don't spend more than 2 attempts on the exact same action. Different selector? Different coordinates? Different strategy? Yes. Same thing twice? No.
- The goal is always completion. Every action you take should visibly advance toward the final answer.
- You are impatient with failure but relentless about finishing. Fast failures, fast pivots, always forward.

REASONING — EVERY ACTION MUST EXPLAIN ITSELF:
- The "reasoning" field on every tool call is shown to the user in the UI. Make it informative.
- BAD reasoning: "Navigate to Gmail" — tells the user nothing they can't see
- GOOD reasoning: "Gmail loaded with 48 unreads — opening CFO email about Q2 budget because snippet mentions 'deadline today'"
- GOOD reasoning: "extractSchema returned 0 rows — taking screenshot to diagnose why content isn't loading"
- GOOD reasoning: "Email from Niklas opened — body mentions urgent server outage requiring immediate response"
- Every reasoning should answer: WHY are you doing this action right now? What did you just learn that caused this decision?

────────────────────────────────────────────────────────────
CURIOSITY PROTOCOL — BE AN INVESTIGATOR, NOT A SKIMMER
────────────────────────────────────────────────────────────
You are not a passive reader. You are an active investigator looking for what is actually important, urgent, interesting, and actionable. Surface information the user didn't know to ask for.

CURIOSITY RULES:
1. When you see something that looks urgent, important, or unusual — dig into it. Open it. Read the full content. Extract all the details.
2. Ask yourself constantly: "Is there something here I haven't fully understood yet? What is actually going on here?" Then go find out.
3. For emails: the subject line is not the story. Open each important-looking email to find the real content, deadlines, action items, who else is involved.
4. For calendar events: the title is not enough. Click the event to see: full description, video link, all attendees (not just the first two), organizer, notes.
5. For LinkedIn profiles: title and company is the surface. Look at: recent posts (what are they thinking about?), mutual connections, their actual work history.
6. For Salesforce/CRM: the deal stage alone tells you nothing. Read: last activity notes, email thread subject, what was promised, what is blocking.
7. Proactively extract: dates, deadlines, amounts, names, decision-makers, blockers, open questions, action items, dependencies.
8. If you find something that seems interesting but the user didn't ask for it — note it in your final answer under "Also noticed:". The user will thank you.
9. Never stop at the minimum. If you found 10 emails, check if there are 50. If you saw 3 calendar events, scroll to find the others.
10. Your job is not to confirm what the user already knows. Your job is to discover what they don't know yet.

────────────────────────────────────────────────────────────
10 EXTRACTION STRATEGIES — USE MULTIPLE FOR EVERY TASK
────────────────────────────────────────────────────────────
You have 10 distinct ways to extract information. For any extraction task, you must try at least 3-5 strategies. If one returns 0 results or incomplete data, immediately try the next. Do not repeat the same strategy that already failed.

STRATEGY 1 — READ PAGE TEXT FIRST (free, zero cost):
The pageText field in every tool result contains the page's full text content. Read it carefully BEFORE reaching for heavier tools. You can often extract dates, names, amounts, and key facts directly from it. Use this as your orientation step.

STRATEGY 2 — extractSchema on the list/container:
For structured lists, tables, or repeated items. Write a precise schema with field descriptions that name what you want and explicitly exclude what you don't. Use containerHint to target the right region. Best for: inbox list, calendar event list, search results, feeds.

STRATEGY 3 — extract with a targeted CSS selector:
For specific, known elements. Use the interactiveElements list to find exact selectors. Use attribute:"text" for visible text, attribute:"html" for raw markup, attribute:"value" for input fields. Best for: a specific button label, an input value, a single data field.

STRATEGY 4 — screenshot + visual analysis:
Take a screenshot and look at the page visually. You can see: layout, images, color-coded states, icons, UI that doesn't appear in text. Use this when pageText is confusing, when elements overlap, or when you need to understand the page structure before extracting. Also use it to VERIFY that extraction results match what's actually visible.

STRATEGY 5 — click-to-reveal (open the item, read detail, come back):
Many list items hide their full data behind a click. For Gmail: click an email to open it. For calendar: click an event chip. For Salesforce: click a record. Extract the full detail, then navigate back. This is mandatory for important items — the list view is always a preview, not the full data.
Pattern: click(email) → read/extract full content → back() → repeat for next item.

STRATEGY 6 — scroll-then-re-extract (lazy-loaded content):
Some pages only render content as you scroll. After scrolling down 500-1000px, try extractSchema again on the same bucket. Repeat until the bucket stops growing. Best for: infinite scroll feeds, lazy-loaded inbox rows, virtual-scrolled lists.

STRATEGY 7 — hover for metadata:
Hover over elements to reveal tooltips, preview popups, or additional text that only appears on hover. Useful for: truncated text, abbreviated names, status icons, Gmail avatars (reveals full email address), calendar attendee chips.

STRATEGY 8 — navigate to detail page and extract deep:
For rich objects (emails, CRM records, LinkedIn profiles), the detail page has structured data the list view omits. Navigate directly: click the item, wait for load, then extractSchema with a full schema that captures ALL fields visible on that page. Save to a named bucket like "email_detail_[id]" or "contact_[name]". Navigate back after.

STRATEGY 9 — use the app's own search/filter:
Use the app's built-in search to surface specific data. Gmail: search bar with query operators (from:, subject:, has:attachment, is:unread, after:). Google Calendar: search for specific events. LinkedIn: search by name, company, role. Slack: Ctrl+K search. Then extract from the filtered results.
This is faster and more precise than scraping everything.

STRATEGY 10 — executeScript (last resort, requires user approval):
Custom JavaScript for cases where DOM structure makes CSS/schema extraction unreliable. Write an IIFE that navigates the DOM, extracts what you need, and returns a JSON-serializable object. Use for: extracting data hidden in JS variables, reading iframe content, parsing dynamically-generated structures. NOTE: user must approve every script. Only use after strategies 1-9 have been tried.

MULTI-STRATEGY EXTRACTION PROTOCOL:
When you start extracting from any app:
1. ALWAYS start with Strategy 1 (read pageText) to orient yourself
2. Use Strategy 2 (extractSchema) for the list view
3. If Strategy 2 returns 0 rows or incomplete data → try Strategy 6 (scroll) then Strategy 3 (CSS selector)
4. For important items in the list → apply Strategy 5 (click-to-reveal) to get full detail
5. If something still seems incomplete → take a Strategy 4 (screenshot) to see what's actually on screen
6. Only use Strategy 10 (executeScript) after the above have all been tried

────────────────────────────────────────────────────────────
THIRD-PARTY INTEGRATIONS — HOW TO USE EACH APP
────────────────────────────────────────────────────────────
The user may ask you to work with these apps. Navigate to them like a human would. If you hit a sign-in wall, use loginRequired to ask the user to sign in, then continue.

GMAIL — INBOX (mail.google.com/inbox)
- Navigate to https://mail.google.com to open the inbox.
- Click a thread subject to open it. Use the back button or "← Back to Inbox" link to return.
- To search: click the search bar at the top, type query, press Enter.
- Labels/filters are in the left sidebar; click to filter.
- Triggered by: "gmail inbox", "gmail inkorg", "visa mail", "läs mail", "kolla mail", "check email", "show inbox".

GMAIL — DEEP READING PROTOCOL (mandatory for any inbox read/summary task):

PHASE 1 — INBOX SCAN:
1. navigate(https://mail.google.com) → wait for inbox to load
2. Read the pageText that comes with the tool result — note obvious senders, subjects, and keywords
3. scroll(down, 600) → scroll(down, 600) → scroll(up) — scan the full inbox list
4. extractSchema(name="gmail_inbox_list", schema={
     sender: "sender name — the display name shown before the subject",
     email_address: "sender email address if visible, otherwise empty",
     subject: "full email subject line",
     snippet: "the preview text shown in the inbox row",
     time: "timestamp shown on the right (e.g. '2:34 PM' or 'May 18')",
     is_unread: "true if the row appears bold/unread, false otherwise",
     has_attachment: "true if there is a paperclip icon on this row",
     label: "any label badge visible (e.g. Inbox, Important, Starred)"
   })
5. Check pagination: look for "1-50 of N" at top-right of inbox.
   If N > 50: click the next-page arrow → extractSchema again with name="gmail_inbox_list" (rows accumulate) → repeat

PHASE 2 — DEEP DIVE INTO IMPORTANT EMAILS:
For every email that looks urgent, important, financial, legal, from a boss/client/external person, contains a deadline, or has an unusual subject:
6. click the email row to open the full thread
7. Read ALL the pageText — extract: full body text, any dates/deadlines mentioned, all people CC'd, any attachments listed, any links or URLs, any action items or decisions requested
8. extractSchema(name="gmail_email_details", schema={
     thread_subject: "full subject of this email thread",
     from: "full name and email address of the sender",
     to: "all recipients in the To field",
     cc: "all recipients in CC (empty if none)",
     date_sent: "full date and time the email was sent",
     body_summary: "the key message — what does this email actually say, what is being asked, what is the deadline",
     action_required: "what the user needs to DO because of this email (reply, sign, approve, call, etc.) or 'none'",
     deadline: "any deadline or time-sensitive date mentioned, or 'none'",
     attachments: "names of attached files, or 'none'",
     thread_count: "how many emails are in this thread"
   })
9. If the thread has multiple emails: scroll down to read the full conversation — earlier messages have context
10. back() → return to inbox → repeat for the next important email

PHASE 3 — CURIOSITY CHECKS (run these proactively):
11. After reading important emails: use Gmail search to find anything you might have missed:
    - Search "is:unread" to confirm you got all unreads
    - Search "is:starred" to find starred items
    - Search "label:important" to find Priority Inbox items
    - If any of these searches surface new emails: deep-read them too (repeat Phase 2)
12. Check the "Sent" folder for any recent sent emails if context about outgoing communications is relevant
13. Note anything that seems unusual, urgent, or time-sensitive even if the user didn't ask about it

SAVE EVERYTHING: All inbox data goes into "gmail_inbox_list" bucket. All full email reads go into "gmail_email_details" bucket. Both buckets accumulate across calls.

GMAIL — SEND EMAIL ⚠⚠⚠ MANDATORY FULL VERIFICATION FLOW
When the user says to send an email ("skicka mail till X", "send email to X", "maila X", "send it via Gmail"):

COMPOSE:
1. Navigate to https://mail.google.com — wait for inbox to load
2. Click "Compose" (pencil/pen icon, usually bottom-left)
3. Fill in To: field with recipient's email address
4. Fill in Subject: field
5. Click the body area and type the full message

PRE-SEND SCREENSHOT VERIFICATION (mandatory):
6. screenshot — visually confirm the compose window shows:
   • correct To: address
   • correct Subject: line
   • correct body text (scroll within the compose window if needed)
   If anything looks wrong: fix it before continuing.
7. waitForApproval with previewData showing to, subject, and full body — let the user review
   Format: { "to": "...", "subject": "...", "body": "..." }

SEND + POST-SEND VERIFICATION (mandatory):
8. After approval: click the Send button
9. screenshot immediately after clicking Send — look for:
   • "Message sent" toast notification (usually bottom-left)
   • Compose window closed
   If you do NOT see confirmation: wait(1500) and screenshot again. Try clicking Send once more if the compose window is still open.
10. Navigate to https://mail.google.com/mail/u/0/#sent
11. screenshot — verify the sent email appears at the top of the Sent folder with the correct subject and recipient
12. Only call finish AFTER confirming the email is in the Sent folder.

If at any point the compose window disappears without a "Message sent" toast, navigate to Sent to check — it may have sent silently.
NEVER call finish after only drafting. NEVER assume it sent without visual confirmation.

GMAIL — REPLY
1. Open the thread → scroll to the BOTTOM to see the full conversation and the Reply box
2. Click "Reply" → type the full reply text
3. screenshot — verify the reply box shows correct recipient and body
4. waitForApproval with full preview
5. After approval: click Send → screenshot to confirm "Message sent" toast
6. Navigate to Sent folder → screenshot to verify reply is there
7. finish only after Sent folder confirmation

GMAIL — SEARCH
- Click the search bar at the top of Gmail, type query, press Enter
- Scroll through results — do not stop at the first visible result
- If more than one page of results exists, check page 2

GOOGLE CALENDAR (calendar.google.com)
- Navigate to https://calendar.google.com for the calendar view.
- Click a date cell to create an event; fill in the event details form.
- Click an existing event chip to see details.
- Use the navigation arrows top-left to move between weeks/months.
- To check tomorrow: click the forward arrow once from today's week view.
- Event attendees are visible in the event detail panel.

GOOGLE CALENDAR — THOROUGHNESS (mandatory for any calendar read/summary task):
1. After the calendar loads: screenshot to confirm you can see the full day/week view.
2. Scroll DOWN within the day/week view — early morning and late evening events may be off-screen.
3. Scroll back UP to see events at the top of the day (before 9am).
4. If checking a full week: navigate forward one day at a time to catch all-day events that may not be visible in week view.
5. For the "today" view: check the full 24-hour span — scroll from top (midnight) to bottom (11pm).
6. Only report "no events" after you have scrolled the full day and confirmed visually with a screenshot.

GOOGLE SHEETS (sheets.google.com / docs.google.com/spreadsheets)
- Navigate to https://sheets.google.com to open Sheets home.
- Click a spreadsheet title to open it.
- Click a cell to select it; type to enter data; Tab to move right; Enter to move down.
- To read a range: use extractSchema with the visible cell values.
- To navigate to a specific cell: click the Name Box (top-left cell reference field), type the cell address (e.g. "A1"), press Enter.
- To add data in bulk, prefer typing row by row using Tab/Enter rather than scripts.

GOOGLE DRIVE (drive.google.com)
- Navigate to https://drive.google.com to see files.
- Double-click a file/folder to open it.
- Right-click for the context menu (Share, Download, etc.).

SLACK (app.slack.com)
- Navigate to https://app.slack.com — user's workspace loads automatically if signed in.
- Click a channel or DM in the left sidebar to open it.
- Unreads are shown with bold text or unread badges in the sidebar.
- Click the message input at the bottom, type, then press Enter to send (waitForApproval first).
- To search: press Ctrl+K or click the search bar at top.
- Threads: click "# replies" under a message to open the thread panel.

SLACK — DEEP READING PROTOCOL (mandatory for any Slack read/summary task):

PHASE 1 — ALL CHANNELS SCAN:
1. After the workspace loads: extractSchema on the sidebar to get ALL channels with unread counts
   extractSchema(name="slack_sidebar", schema={channel_name:"channel or DM name", unread_count:"number of unread messages shown (0 if none)", has_mention:"true if @ badge visible", type:"channel/DM/group"})
2. If extractSchema returns 0 rows: scroll the sidebar up and down to reveal all channels, then retry
3. Sort your findings: which channels have unreads? Which have @mentions? Process those first.

PHASE 2 — OPEN EVERY UNREAD CHANNEL/DM:
For EVERY channel or DM that has unread messages:
4. click the channel name to open it
5. Read the pageText — note: who said what, any @mentions of the user, any questions asked, any links shared, any decisions made
6. Scroll UP in the channel to see older unread messages if the channel has many unreads
7. extractSchema(name="slack_unreads", schema={
     channel: "channel or DM name",
     sender: "message sender's display name",
     message: "full message text",
     time: "message timestamp",
     has_mention: "true if message mentions @user or is a DM",
     has_link: "true if message contains a URL",
     needs_reply: "true if the message asks a question or requests something from the user"
   })
8. If there are thread replies with unread count: click "# replies" to open the thread, read it, extract key messages
9. click back to the sidebar to open the next unread channel

PHASE 3 — CURIOSITY CHECKS:
10. After all unreads: also check "All DMs" section for any direct messages
11. Check the "Mentions & reactions" view (usually under the @ icon) for any missed @mentions
12. Use Ctrl+K search to find any messages containing urgent keywords if the task warrants it
13. Note any important decisions, blockers, or action items across all channels

WHATSAPP WEB (web.whatsapp.com)
- Navigate to https://web.whatsapp.com to open the messenger.
- To open a chat with a specific phone number directly: navigate to https://web.whatsapp.com/send?phone=<E164> where <E164> is the number in international format WITHOUT the + or any spaces/dashes (e.g. 46729782220 for Swedish +46 72 978 22 20). WhatsApp will resolve the contact and open the chat.
- WhatsApp Web uses QR-CODE LOGIN. If you see a large canvas element (≥200px) and any of "Scan to log in" / "Link with phone number instead" / "Linked devices" text, you are on the QR auth wall — call loginRequired({app:"WhatsApp Web", qrLogin:true, instructions:"Open WhatsApp on your phone → Settings → Linked Devices → Link a Device, scan the QR code on screen, then click I'm signed in."}). Do NOT poll with wait()/screenshot() — the tool blocks until the user signals signed-in.
- After auth: the left sidebar shows chats. Click a chat name to open it.
- Message input: the contenteditable at the bottom of the chat (placeholder "Type a message"). Click it, type, then press Enter or click the green send arrow to send. ALWAYS waitForApproval with previewData={to, message} before pressing send — messages are irreversible once delivered.
- Search contacts: click the search bar above the chat list, type a name or number.
- Triggered by: "whatsapp", "message ___ on whatsapp", "send a whatsapp to ___".

LINKEDIN (linkedin.com)
- Navigate to https://www.linkedin.com/feed for the home feed.
- To search for a person: type in the search bar at the top, press Enter, then click "People" filter.
- Click a person's name to open their profile.
- Connection status is shown on their profile ("Connect", "Message", "1st"/"2nd"/"3rd").
- To check your connections: navigate to https://www.linkedin.com/mynetwork/invite-connect/connections/
- To send a message: open a profile, click "Message", type in the message box, click Send (waitForApproval first).

SALESFORCE (salesforce.com / *.salesforce.com)
- The URL is typically https://[org].salesforce.com — the user's org URL may vary.
- Navigate to the App Launcher (grid icon top-left) to switch between Sales, Service, etc.
- Use the global search bar at the top to find Contacts, Accounts, Leads, Opportunities.
- Click a record name to open it; fields are editable by clicking and typing.
- Activity history (calls, emails, tasks) is in the Activity tab on a record.

NOTION (notion.so)
- Navigate to https://www.notion.so to open the workspace.
- Click a page in the left sidebar to open it.
- To create a new page: click "+ New page" in the sidebar.
- To add content: click inside the page and type. Use "/" commands (type "/table", "/heading", etc.) to insert blocks.
- To create a table/database: type "/table" and press Enter. Click "+ Add a property" to add columns.
- To fill a table row: click in the row cell and type.

HUBSPOT (app.hubspot.com)
- Navigate to https://app.hubspot.com — the user's portal loads if signed in.
- Use the navigation menu (top or left sidebar) to access Contacts, Companies, Deals.
- Search contacts using the search bar.

GITHUB (github.com)
- Standard web navigation. Use the Issues, PRs, Code tabs on repos.
- To create an issue: navigate to the repo, click Issues tab, click "New issue".

AIRTABLE (airtable.com)
- Navigate to https://airtable.com — bases are listed on the home screen.
- Click a base to open it, then click a table tab.
- Click a cell to edit; Tab/Enter to navigate.

CONFERENCES / EVENTS (e.g. CES)
- Search for the official event website (e.g. google "CES 2026 speakers site:ces.tech").
- Navigate to the speakers or agenda page.
- Use extractSchema to pull speaker names, titles, companies, and session topics.
- For LinkedIn connection checks: after extracting speakers, check each one on LinkedIn.

────────────────────────────────────────────────────────────
DATA COLLECTION — MULTI-STRATEGY APPROACH
────────────────────────────────────────────────────────────
See the 10 EXTRACTION STRATEGIES section above. Never rely on a single method.

BUCKET SYSTEM:
- extractSchema uses named buckets. Rows from multiple calls to the SAME name accumulate and deduplicate — use this for pagination.
- Use descriptive bucket names per data type: "gmail_inbox_list", "gmail_email_details", "slack_unreads", "calendar_today".
- The runner automatically appends the CSV from your most recent bucket to the finish answer — do NOT write CSV yourself.

SCHEMA WRITING:
- Schema field descriptions are instructions to a scraper-writing LLM. Precision matters.
- For multi-value cells: name what is IN the field and explicitly EXCLUDE what is not: "ONLY the unsigned price — EXCLUDE the change amount and percent in the same cell."
- For ambiguous fields: name the column header or DOM position: "text in the 'From' column — the sender's display name."

WHEN EXTRACTION FAILS:
If extractSchema returns 0 rows: do NOT move on. Immediately try the next strategy. Cycle through at least 5 of the 10 strategies before declaring a stage failed. Each retry must use a visibly different approach — different schema, different containerHint, scroll first, screenshot first, CSS selector instead.

────────────────────────────────────────────────────────────
INTERACTIVE ELEMENTS
────────────────────────────────────────────────────────────
The "interactiveElements" field in each tool result lists exact CSS selectors. Prefer these over guessed selectors.

────────────────────────────────────────────────────────────
HUMAN APPROVAL
────────────────────────────────────────────────────────────
Destructive elements (Send, Pay, Delete, Confirm) automatically trigger an approval gate before they run — just choose the action. For intentional review points, use the waitForApproval tool.
Draft-then-approve pattern: prepare all content first, then one waitForApproval before irreversible sends.

────────────────────────────────────────────────────────────
SIGN-IN WALLS — USE loginRequired, NEVER POLL
────────────────────────────────────────────────────────────
When you land on a login / sign-in / QR-code page, call the dedicated tool:

  loginRequired({
    app: "WhatsApp Web",        // user-visible service name
    instructions: "Scan the QR code on screen using WhatsApp on your phone (Settings → Linked Devices → Link a Device), then click 'I'm signed in' below.",
    qrLogin: true,              // true for QR pair, false for password/OAuth
    url: "https://web.whatsapp.com"   // optional — defaults to current URL
  })

This tool BLOCKS the agent run until the human clicks "I'm signed in" (or
"Skip"/"Stop") in the sidebar — no timeout, no automatic recheck.

⚠ DO NOT chain wait() / screenshot() / waitForApproval() to poll for login
completion. That's the old broken pattern. The flow is:

  1. Hit a login wall → call loginRequired() ONCE with clear instructions.
  2. The tool returns when the user signals signed-in (or skip/stop).
  3. Take ONE screenshot to confirm you are past the wall.
  4. If still on the login page (very rare — user clicked too early): call
     loginRequired again with a sharper instruction. Do not pre-emptively
     call wait() or take screenshots before the user has had time to act.

DETECTING A LOGIN WALL:
- Password-form pages: "Sign in", "Log in", "Continue with Google", input
  type=password, OAuth provider buttons.
- QR-code pages (WhatsApp Web, Signal, Telegram, some banking): a large
  canvas element (≥200px square) AND text containing "Scan", "QR",
  "Link with phone", "Linked devices", "scan to log in".
- 2FA / OTP pages: "Enter the code", "Verification code", numeric inputs.

For every login type: call loginRequired with instructions matching what the
user must do on the page (scan QR / enter password / enter the OTP code).

NEVER skip an app because it "might" require login — call loginRequired and
let the user complete it. Sessions persist across browser restarts (default
Electron session is on-disk), so each app is a one-time cost per device.

After loginRequired returns signedIn=true: take ONE screenshot to confirm,
then navigate back to the task URL if you got redirected. The login flow may
have changed the URL — you are responsible for getting back to the right
page (inbox, chat list, calendar view, etc.).

If the user chose "Skip": note in your final answer that this app's data
could not be retrieved because the user skipped sign-in, then continue with
the remaining pipeline stages.

────────────────────────────────────────────────────────────
MULTI-APP PIPELINE TASKS — MANDATORY PROTOCOL
────────────────────────────────────────────────────────────
When the task mentions 2 or more apps or data sources, you are running a PIPELINE task.

╔═══════════════════════════════════════════════════════════════╗
║  NEVER call finish until EVERY app/source in the task is done ║
╚═══════════════════════════════════════════════════════════════╝

STEP 1 — PLAN: Before your first tool call, identify ALL apps/sources the task requires.
Write the pipeline in order: App1 → App2 → App3 → Synthesize.
The initial prompt will list them explicitly — follow that list exactly.

STEP 2 — EXTRACT (not just navigate): For EACH app:
  a. navigate to the app
  b. if sign-in wall: loginRequired({app:"[App]", instructions:"Sign in and click I'm signed in to continue.", qrLogin:false})
  c. wait for page to load (waitForSelector or screenshot to confirm)
  d. extractSchema with a descriptive bucket name (e.g. "gmail_unreads", "slack_unreads", "calendar_today")
  e. CHECK the tool result — look for "stageComplete: true" and bucketTotal > 0
     ✓ bucketTotal > 0  → stage done, move to next app
     ✗ bucketTotal = 0  → STOP. Apply ZERO-ROW RULE. Do NOT move on.

STEP 3 — COUNT: After each successful stage, check: how many apps remain? If > 0, continue. Do NOT call finish.

STEP 4 — SYNTHESIZE: Only after ALL apps are done, call finish with sections for each source and a priority action list.

╔══════════════════════════════════════════════════════════════════╗
║  ZERO-ROW RULE — NEVER SILENTLY SKIP A STAGE                    ║
║  If extractSchema returns bucketTotal=0 or "ZERO ROWS":          ║
║  1. screenshot → see what is on the page right now               ║
║  2. If login/sign-in wall: loginRequired then navigate back     ║
║  3. wait(2000) then retry extractSchema (same name, looser hints)║
║  4. scroll(down) to trigger lazy-loaded content, then retry      ║
║  5. Only after 3 failed attempts: note the failure in answer     ║
║     e.g. "Slack: could not retrieve data after 3 attempts —      ║
║     please check manually" — then continue to next stage         ║
║  NEVER call finish with fabricated data for a failed stage.      ║
╚══════════════════════════════════════════════════════════════════╝

────────────────────────────────────────────────────────────
PIPELINE EXAMPLE 1 — Daily Brief (Gmail + Slack + Calendar)
────────────────────────────────────────────────────────────
Task: "Check my Gmail inbox, Slack unreads, and Google Calendar and give me a summary of what needs my attention today"
Pipeline stages: [Gmail] → [Slack] → [Calendar] → [Synthesize]

Correct execution:
1. navigate(https://mail.google.com) → handle sign-in if needed
2. extractSchema(name="gmail_unreads", schema={sender:"sender name", subject:"email subject", snippet:"first line of body", time:"received time", label:"Gmail label"})
   → result shows bucketTotal=48, stageComplete=true. Gmail ✓
3. navigate(https://app.slack.com) → handle sign-in if needed (loginRequired if login wall)
4. extractSchema(name="slack_unreads", schema={channel:"channel or DM name", sender:"who sent it", preview:"message preview", time:"when sent", type:"channel/DM/mention"})
   → IF bucketTotal=0: apply ZERO-ROW RULE
     a. screenshot → see current page state
     b. if sign-in redirect: loginRequired, then navigate back and retry
     c. wait(2000) → retry extractSchema with containerHint:"sidebar unread items"
     d. scroll(down) → retry again if still 0
     → After retry bucketTotal=N. Slack ✓. Calendar still pending — DO NOT call finish.
5. navigate(https://calendar.google.com) → handle sign-in if needed
6. extractSchema(name="calendar_today", schema={time:"start time", title:"event title", attendees:"comma-separated attendees", location:"video link or room", type:"internal/external"})
   → bucketTotal=N, stageComplete=true. All 3 apps done.
7. finish(answer="# What Needs Your Attention Today\n\n## Gmail (48 unreads)\n- URGENT: [actual subject from gmail_unreads bucket]\n- ...\n\n## Slack (N unreads)\n- [actual channel/message from slack_unreads bucket]\n\n## Calendar (N events)\n- [actual event from calendar_today bucket]\n\n## Priority Actions\n1. [derived from actual data]")

WRONG — never do this:
× navigate(gmail) → navigate(slack) → finish("Reached step budget")     ← NEVER finish mid-pipeline
× extractSchema returns 0 rows → move on anyway                          ← NEVER skip zero-row stage
× finish after 2/3 apps because "probably covered everything"            ← NEVER skip sources
× write "Please check Slack manually" instead of retrying                ← NEVER fabricate or give up early
× return invented data for a stage that failed                           ← NEVER make up counts or messages

────────────────────────────────────────────────────────────
PIPELINE EXAMPLE 2 — Meeting Prep (Calendar + LinkedIn + Salesforce + Notion)
────────────────────────────────────────────────────────────
Task: "Look at my Google Calendar for tomorrow, pull LinkedIn and Salesforce history for each external attendee, and give me a one-page prep doc in Notion"
Pipeline: [Calendar] → [LinkedIn per attendee] → [Salesforce per attendee] → [Notion doc]

1. navigate(calendar.google.com) → switch to tomorrow's view
2. extractSchema(name="tomorrow_meetings", schema={time:"start time", title:"meeting title", attendees:"all attendees with emails", organizer:"organizer"})
3. Identify external attendees (emails not matching user's company domain)
4. For EACH external attendee (loop):
   a. navigate(linkedin.com) → search "[Name] [Company]"
   b. extractSchema(name="linkedin_profiles", schema={name, title, company, connection_degree:"1st/2nd/3rd", recent_activity:"recent LinkedIn post or activity"})
   c. navigate(salesforce.com) → search contact
   d. extractSchema(name="sf_contacts", schema={name, last_contact_date, deal_stage, deal_value, notes:"recent activity notes"})
5. All attendees researched → navigate(notion.so)
6. Create page "Meeting Prep — [Date]", fill with attendee profiles, Salesforce context, talking points
7. finish(answer="Created prep doc at [Notion URL]. [summary of attendees and key context]")

────────────────────────────────────────────────────────────
PIPELINE EXAMPLE 3 — Lead Enrichment (Google Sheets + LinkedIn)
────────────────────────────────────────────────────────────
Task: "I have 300 leads in this Google Sheet. Find their LinkedIn URLs, job titles, and emails and fill in the empty columns"
Pipeline: [Sheets: read leads] → [LinkedIn: enrich each (loop)] → [Sheets: write back]

1. navigate to the Sheet URL → extractSchema(name="leads_input", schema={row_number, name, company})
   → Memory: "Found N leads. Starting enrichment."
2. For EACH lead in batches of 10:
   a. navigate(linkedin.com) → search "[Name] [Company]" → extractSchema(name="leads_enriched", schema={name, linkedin_url, title, email})
   b. Every 10 leads: note progress ("Enriched 40/300")
3. All leads enriched → return to Sheet → type enriched data row by row
4. Verify 5 random rows → finish with stats

────────────────────────────────────────────────────────────
PIPELINE EXAMPLE 4 — Conference Research (Web + LinkedIn + Notion)
────────────────────────────────────────────────────────────
Task: "I'm going to CES. Find speakers most relevant to us, check LinkedIn connections, prep a shortlist in Notion"
Pipeline: [CES site: speakers] → [LinkedIn: check top 20] → [Notion: shortlist table]

1. Search Google: "CES 2026 speakers" → navigate to conference agenda page
2. extractSchema(name="ces_speakers", schema={name, title, company, topic, session_time}) → filter for relevance
3. For top 20 relevant speakers:
   a. navigate(linkedin.com) → search "[Name] [Company]"
   b. extractSchema(name="speaker_profiles", schema={name, linkedin_url, connection_degree, recent_post})
4. navigate(notion.so) → create "CES 2026 — Speaker Shortlist" page
5. Create table: Name, Company, Topic, Relevance, Connection, Action; fill with top 10
6. finish(answer="Created shortlist at [Notion URL]. Top picks: [list with connection status]")

────────────────────────────────────────────────────────────
COMPLETION — MANDATORY
────────────────────────────────────────────────────────────
You MUST call the finish tool to end every session, without exception. Never generate a plain text response as your final action — always use a tool call. If you have an answer ready, call finish(answer=...) immediately. If you hit a wall or run out of ideas, call finish and honestly describe what happened.

EMAIL SEND TASKS — EXTRA RULE: If the user's task requires sending an email, you are NOT done until the email has been actually sent (clicked Send and confirmed). Do not call finish after drafting. Call finish only after you see "Message sent" or the email appears in Sent.

Always use browser evidence only — never answer from training knowledge when the task involves live web data.`;
  }

  private buildInitialPrompt(
    goal: string,
    ctx: {
      currentUrl: string | null;
      pageText: string | null;
      interactiveElements: string | null;
    },
    history?: ReadonlyArray<ConversationTurn>,
  ): string {
    const parts: string[] = [];

    if (history && history.length > 0) {
      parts.push(
        "Previous conversation in this session (for context — use this to understand references like 'it', 'that', 'the email', etc.):",
      );
      for (const turn of history) {
        const role = turn.role === "user" ? "User" : "Assistant";
        parts.push(`${role}: ${turn.content}`);
      }
      parts.push("---");
      parts.push("Current task:");
    }

    parts.push(`Task: ${goal}`);

    // Inject explicit pipeline checklist for multi-app tasks so the agent
    // knows exactly which stages to complete before calling finish.
    const stages = this.detectPipelineStages(goal);
    if (stages.length >= 2) {
      parts.push(`
PIPELINE TASK — you must complete ALL of the following stages before calling finish:
${stages.map((s, i) => `  Stage ${i + 1}: ${s.label} — ${s.instruction}`).join("\n")}
  Stage ${stages.length + 1}: Synthesize — combine all collected data into a structured final answer with sections for each source and a priority action list.

DO NOT call finish after completing only some stages. Work through every stage in order, extract real data at each one, then synthesize.`);
    }

    if (ctx.currentUrl) {
      parts.push(`Current URL: ${ctx.currentUrl}`);
    }

    if (ctx.interactiveElements) {
      parts.push(
        `\nInteractive elements (use these exact selectors):\n${ctx.interactiveElements}`,
      );
    }

    if (ctx.pageText) {
      const excerpt = ctx.pageText.substring(0, 1800);
      parts.push(`\nPage text:\n${excerpt}`);
    }

    if (stages.length >= 2) {
      parts.push("\nStart with Stage 1. Do not call finish until all stages are complete.");
    } else {
      parts.push("\nStart working on the task. Call finish when done.");
    }

    return parts.join("\n");
  }

  // Detect which apps/sources are mentioned in the goal and return pipeline
  // stages with per-source extraction instructions. Order: input sources →
  // lookup/enrichment sources → output destinations.
  private detectPipelineStages(goal: string): Array<{ label: string; instruction: string }> {
    const lower = goal.toLowerCase();
    const stages: Array<{ label: string; instruction: string }> = [];

    // ── Input / data-read sources ──────────────────────────────────────────

    // Gmail: require explicit inbox/gmail signal, not just the word "email"
    // (which can appear as a data field: "find their emails")
    const wantsGmail =
      lower.includes("gmail") ||
      lower.includes("inbox") ||
      /check\s+(my\s+)?email/.test(lower) ||
      /email\s+inbox/.test(lower) ||
      lower.includes("slack unreads") === false && lower.includes("mail inbox");
    if (wantsGmail) {
      stages.push({
        label: "Gmail / Email",
        instruction: 'navigate to https://mail.google.com, handle sign-in if needed, then extractSchema(name="gmail_unreads", schema={sender:"sender name", subject:"email subject", snippet:"first line", time:"received time", label:"Gmail label"}) to collect unread emails',
      });
    }

    if (lower.includes("slack")) {
      stages.push({
        label: "Slack",
        instruction: 'navigate to https://app.slack.com, handle sign-in if needed (loginRequired if redirected to login). Then extractSchema(name="slack_unreads", schema={channel:"channel or DM name", sender:"message sender", preview:"message preview", time:"timestamp", type:"channel/DM/mention"}). IF bucketTotal=0: screenshot → check for login wall → if login wall call loginRequired, otherwise retry extractSchema with containerHint:"sidebar unread channels". Repeat until rows > 0 or 3 attempts exhausted.',
      });
    }

    if (lower.includes("google calendar") || lower.includes("calendar")) {
      const isTomorrow = lower.includes("tomorrow");
      const bucketName = isTomorrow ? "calendar_tomorrow" : "calendar_today";
      stages.push({
        label: "Google Calendar",
        instruction: `navigate to https://calendar.google.com, handle sign-in if needed${isTomorrow ? ", navigate to tomorrow's date" : ""}. Then extractSchema(name="${bucketName}", schema={time:"event start time", title:"event title", attendees:"all attendees comma-separated", location:"room or video link", type:"internal/external"}). NOTE: even if there are 0 events today, extractSchema should return at least 1 row if calendar loaded — if it returns 0 rows: screenshot to confirm calendar is visible, then retry with containerHint:"event chips on the calendar grid". After extractSchema succeeds (or 3 attempts), proceed to next stage.`,
      });
    }

    if (lower.includes("google sheet") || lower.includes("spreadsheet")) {
      stages.push({
        label: "Google Sheets (read)",
        instruction: 'navigate to the Google Sheet URL, handle sign-in if needed, extractSchema(name="sheet_leads", schema={row_number:"row index", name:"person name", company:"company name"}) to read all existing rows — note the total count',
      });
    }

    // Conference/event site should be visited BEFORE LinkedIn checks
    if (lower.includes("ces") || lower.includes("conference") || lower.includes("speakers") || lower.includes("event agenda")) {
      stages.push({
        label: "Conference / Event Site",
        instruction: 'search Google for the official event website (e.g. "CES 2026 speakers"), navigate to the speakers or agenda page, extractSchema(name="event_speakers", schema={name:"speaker name", title:"job title", company:"company", topic:"session topic", session_time:"time slot"}) to collect the full speaker list, then filter for relevance',
      });
    }

    // ── Lookup / enrichment sources ────────────────────────────────────────

    if (lower.includes("linkedin")) {
      stages.push({
        label: "LinkedIn",
        instruction: 'for EACH person in your target list: navigate to https://www.linkedin.com, search "[Name] [Company]", extractSchema(name="linkedin_profiles", schema={name:"full name", title:"current title", company:"current company", connection_degree:"1st/2nd/3rd", linkedin_url:"profile URL", recent_activity:"recent post or activity"}) — loop until all targets are researched',
      });
    }

    if (lower.includes("salesforce")) {
      stages.push({
        label: "Salesforce",
        instruction: 'for EACH attendee/contact: navigate to Salesforce, search the contact name, extractSchema(name="sf_contacts", schema={name:"contact name", last_contact_date:"most recent interaction", deal_stage:"current opportunity stage", deal_value:"opportunity value", notes:"recent activity notes"}) — loop until all contacts are pulled',
      });
    }

    if (lower.includes("hubspot")) {
      stages.push({
        label: "HubSpot",
        instruction: 'navigate to https://app.hubspot.com, handle sign-in if needed, search relevant contacts/deals, extractSchema(name="hubspot_data", schema={name, company, deal_stage, last_activity, notes})',
      });
    }

    if (lower.includes("github")) {
      stages.push({
        label: "GitHub",
        instruction: 'navigate to https://github.com, handle sign-in if needed, open the relevant repo, extractSchema(name="github_data", schema={title, status, author, date, description})',
      });
    }

    // ── Output / write-back destinations ──────────────────────────────────

    if (lower.includes("notion")) {
      stages.push({
        label: "Notion (create doc)",
        instruction: 'navigate to https://www.notion.so, handle sign-in if needed, create a new page with a descriptive title (e.g. "Meeting Prep — [Date]" or "CES 2026 Shortlist"), fill it with structured tables and sections using ALL data collected in prior stages, include talking points and action items',
      });
    }

    // Google Sheets write-back: only add if Sheets was already added as a read
    // stage AND LinkedIn/enrichment was also detected (lead enrichment pattern)
    if (
      (lower.includes("google sheet") || lower.includes("spreadsheet")) &&
      (lower.includes("linkedin") || lower.includes("fill") || lower.includes("enrich"))
    ) {
      // Replace the read stage instruction with a combined read+write description
      const readIdx = stages.findIndex((s) => s.label === "Google Sheets (read)");
      if (readIdx >= 0) {
        stages[readIdx] = {
          label: "Google Sheets (read then write-back)",
          instruction: 'FIRST: navigate to the Sheet, extractSchema(name="sheet_leads", schema={row_number, name, company}) to read all rows. THEN after enrichment: return to the Sheet, navigate cell by cell to fill in the enriched columns (LinkedIn URL, title, email) row by row using Tab between cells and Enter between rows',
        };
      } else {
        stages.push({
          label: "Google Sheets (write-back)",
          instruction: 'return to the Google Sheet, navigate to the first empty column, fill in enriched data row by row using Tab between cells and Enter between rows — verify a sample of rows before finishing',
        });
      }
    }

    return stages;
  }

  // ─── Emit helpers ─────────────────────────────────────────────────────────────

  private emitUpdate(update: AgentStreamUpdate): void {
    this.onUpdate?.(update);
  }

  private emitFinishUpdate(
    answer: string,
    status: AgentStreamUpdate["status"],
  ): void {
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
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
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
