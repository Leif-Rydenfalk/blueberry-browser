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

export interface DelegateTaskArgs {
  readonly task: string;
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
    "Delegate a web-UI task to Blueberry Browser. The task is executed in a real browser as if a human were doing it — clicks, typing, scrolling, form fills. Use natural language: \"Message 'hi' to John Doe on LinkedIn\", \"Send a Gmail to alice@example.com with the body ...\", \"Pull the last 50 transactions from my bank dashboard into a CSV\". Returns the agent's final answer plus the session id.",
  inputSchema: {
    type: "object",
    required: ["task"],
    properties: {
      task: {
        type: "string",
        description:
          "Plain-English instruction describing what to do in the browser.",
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
