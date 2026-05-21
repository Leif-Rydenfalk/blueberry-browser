// MCP (Model Context Protocol) types and tool schemas for Blueberry's
// delegation endpoint. See MCP_DELEGATION.md for the protocol overview.
//
// We hand-roll the wire format (JSON-RPC 2.0) rather than depend on
// @modelcontextprotocol/sdk because the surface is tiny (initialize +
// tools/list + tools/call) and the SDK would add ~MB of dependencies to
// the Electron bundle.

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export const MCP_DEFAULT_PORT = 7777;
export const MCP_DEFAULT_HOST = "127.0.0.1";

export const MCP_CHANNELS = {
  STATUS_CHANGED: "mcp:status-changed",
  REQUEST_RECEIVED: "mcp:request-received",
  REQUEST_COMPLETED: "mcp:request-completed",
  GET_STATUS: "mcp:get-status",
} as const;

// ---- JSON-RPC envelopes ----

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result: T;
}

export interface JsonRpcError {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError;

// MCP error codes (a subset of JSON-RPC 2.0 + MCP-specific ones)
export const MCP_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AGENT_BUSY: -32000,
  AGENT_FAILED: -32001,
  SERVER_UNREACHABLE: -32002,
} as const;

// ---- MCP message bodies ----

export interface McpInitializeParams {
  readonly protocolVersion: string;
  readonly capabilities?: Record<string, unknown>;
  readonly clientInfo?: { readonly name?: string; readonly version?: string };
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: {
    readonly tools: { readonly listChanged: boolean };
  };
  readonly serverInfo: { readonly name: string; readonly version: string };
}

export interface McpToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpToolsListResult {
  readonly tools: ReadonlyArray<McpToolSchema>;
}

export interface McpToolCallParams {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
}

export interface McpToolCallResult {
  readonly content: ReadonlyArray<McpContent>;
  readonly isError?: boolean;
}

export type McpContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

// ---- Blueberry-specific tool: delegate_task ----

export interface McpAttachment {
  readonly type: "url" | "file";
  readonly name: string;
  readonly content?: string;
  readonly url?: string;
  readonly mimeType?: string;
}

export interface DelegateTaskArgs {
  readonly task: string;
  readonly attachments?: ReadonlyArray<McpAttachment>;
}

export interface DelegateTaskResult {
  readonly sessionId: string;
  readonly status: "completed" | "error" | "aborted";
  readonly answer: string | null;
  readonly stepCount: number;
  readonly url: string | null;
  readonly error?: string;
}

export const DELEGATE_TASK_TOOL: McpToolSchema = {
  name: "delegate_task",
  description:
    "Delegate a web-UI task to Blueberry Browser. The task is executed in a real browser as if a human were doing it — clicks, typing, scrolling, form fills. Use natural language: \"Message 'hi' to John Doe on LinkedIn\", \"Send a Gmail to alice@example.com with the body ...\", \"Pull the last 50 transactions from my bank dashboard into a CSV\". Returns the agent's final answer plus the session id. Supports optional `attachments` for passing URLs to navigate to or file content to use as context.",
  inputSchema: {
    type: "object",
    required: ["task"],
    properties: {
      task: {
        type: "string",
        description:
          "Plain-English instruction describing what to do in the browser.",
      },
      attachments: {
        type: "array",
        description: "Optional URLs or file content to provide as context.",
        items: {
          type: "object",
          required: ["type", "name"],
          properties: {
            type: { type: "string", enum: ["url", "file"], description: "url or file" },
            name: { type: "string", description: "Human-readable label" },
            url: { type: "string", description: "URL to navigate to (when type=url)" },
            content: { type: "string", description: "File text content (when type=file)" },
            mimeType: { type: "string", description: "MIME type hint (optional)" },
          },
        },
      },
    },
  },
};

// ---- Blueberry-specific tool: delegate_workflow ----

export interface DelegateWorkflowStep {
  readonly name: string;
  readonly task: string;
  // Step names whose answers to inject; defaults to all previous steps.
  readonly dependsOn?: ReadonlyArray<string>;
}

export interface DelegateWorkflowArgs {
  readonly steps: ReadonlyArray<DelegateWorkflowStep>;
  readonly context?: string;
  readonly attachments?: ReadonlyArray<McpAttachment>;
}

export interface DelegateWorkflowStepResult {
  readonly name: string;
  readonly status: "completed" | "error" | "aborted";
  readonly answer: string | null;
  readonly stepCount: number;
  // Cumulative bucket inventory at the end of this step. Includes anything
  // inherited from prior steps in the same workflow (buckets persist across
  // steps). MCP clients can read structured rows from here even when the agent
  // chose narrative-only in finish().
  readonly bucketSummaries?: ReadonlyArray<{
    readonly name: string;
    readonly count: number;
    readonly fields: ReadonlyArray<string>;
    readonly sample: ReadonlyArray<unknown>;
  }>;
  readonly error?: string;
}

export interface DelegateWorkflowResult {
  readonly workflowId: string;
  readonly status: "completed" | "partial" | "error";
  readonly steps: ReadonlyArray<DelegateWorkflowStepResult>;
  readonly finalAnswer: string | null;
  readonly totalStepCount: number;
  readonly error?: string;
}

export const DELEGATE_WORKFLOW_TOOL: McpToolSchema = {
  name: "delegate_workflow",
  description:
    "Execute a structured multi-step workflow across multiple web apps. Each step runs sequentially in a real browser; answers from earlier steps are automatically passed as context to later steps. Ideal for cross-app workflows: inbox + calendar briefs, meeting prep from LinkedIn + Salesforce, lead enrichment across sheets + profiles, conference discovery + Notion shortlists.",
  inputSchema: {
    type: "object",
    required: ["steps"],
    properties: {
      steps: {
        type: "array",
        description:
          "Steps to execute in order. Each step's answer becomes context for subsequent steps.",
        minItems: 2,
        maxItems: 10,
        items: {
          type: "object",
          required: ["name", "task"],
          properties: {
            name: {
              type: "string",
              description: "Unique step identifier used for context injection (e.g. 'gmail', 'calendar', 'synthesis')",
            },
            task: {
              type: "string",
              description: "Plain-English instruction for this step.",
            },
            dependsOn: {
              type: "array",
              items: { type: "string" },
              description:
                "Step names whose answers to inject as context. Defaults to all previous steps.",
            },
          },
        },
      },
      context: {
        type: "string",
        description:
          "Optional shared background for all steps (user preferences, company name, date, etc.).",
      },
    },
  },
};

// ---- IPC payloads (main → sidebar) ----

export interface McpStatus {
  readonly enabled: boolean;
  readonly listening: boolean;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly totalRequests: number;
  readonly lastError: string | null;
}

export interface McpRequestEvent {
  readonly id: string;
  readonly receivedAt: number;
  readonly task: string;
  readonly clientInfo?: { readonly name?: string; readonly version?: string };
}

export interface McpCompletionEvent {
  readonly id: string;
  readonly completedAt: number;
  readonly status: DelegateTaskResult["status"];
  readonly answer: string | null;
  readonly stepCount: number;
  readonly error?: string;
}

// Fired when the active agent run is blocked on a login wall and needs the
// human at the local desktop to sign in. External agents (which delegated
// the task over MCP) can subscribe via /mcp/sse to know that progress has
// paused and to display this to *their* user. They cannot resolve it —
// authentication must happen on the Blueberry desktop.
export interface McpLoginRequiredEvent {
  readonly sessionId: string;
  readonly app: string;
  readonly instructions: string;
  readonly qrLogin: boolean;
  readonly url: string | null;
  readonly createdAt: number;
}

// Fired once per agent step while a delegation is in progress. Allows the
// calling agent to track execution, surface live progress to its UI, and
// detect when partial data is already usable.
export interface McpProgressEvent {
  readonly taskId: string;       // McpHandler request ID — correlates with the request/complete events
  readonly sessionId: string;    // Agent session ID
  readonly stepNum: number;      // 1-based step counter within this run
  readonly maxSteps: number;     // Step budget for this run
  readonly actionType: string;   // e.g. "navigate", "click", "extractSchema", "finish"
  readonly reasoning: string;    // Agent's reasoning for this action (shown in sidebar)
  readonly status: "running" | "success" | "error";
  readonly currentUrl: string | null;
  readonly timestamp: number;    // Unix ms
}

// ---- steer_task tool ----

export const STEER_TASK_TOOL: McpToolSchema = {
  name: "steer_task",
  description:
    "Send a steering instruction to the currently running agent. The message is injected into the agent's next tool result so it can adjust direction, correct a mistake, add context, or change scope. Non-blocking — returns immediately. If no agent is running, returns queued:false.",
  inputSchema: {
    type: "object",
    required: ["message"],
    properties: {
      message: {
        type: "string",
        description:
          "Instruction or correction for the running agent. Plain English. Examples: \"Stop searching for more leads — you already have enough. Finish now.\", \"The data you found is correct. Now write it back to the sheet.\", \"Skip Salesforce — the user doesn't have access. Move to the Notion step.\"",
      },
    },
  },
};

// ---- get_task_status tool ----

export interface McpTaskStatusResult {
  readonly active: boolean;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly status?: "running" | "paused" | "completed" | "error";
  readonly goal?: string;
  readonly stepNum?: number;
  readonly maxSteps?: number;
  readonly elapsedMs?: number;
  readonly startedAt?: number;
  readonly queueDepth?: number;
}

export const GET_TASK_STATUS_TOOL: McpToolSchema = {
  name: "get_task_status",
  description:
    "Query the current state of the running agent without blocking. Returns step progress, elapsed time, and status. Subscribe to /mcp/sse for real-time step events instead of polling this.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};
