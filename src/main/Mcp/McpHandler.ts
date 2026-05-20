// Bridges MCP tool calls into Blueberry's agent runtime. The HTTP+SSE server
// (McpServer) and the stdio bridge both call into this one class so the
// delegate_task contract is implemented exactly once.
//
// Concurrency policy: Blueberry's agent owns the single active tab. Allowing
// two concurrent delegations would have them stomping on each other's clicks.
// We therefore serialize MCP requests with a FIFO queue. Callers see this as
// "your task waits its turn"; if the queue is over the cap they get an
// `agent_busy` error rather than waiting forever.

import { v4 as uuidv4 } from "uuid";
import type { AgentOrchestrator } from "../Agent/core/AgentOrchestrator";
import {
  DELEGATE_TASK_TOOL,
  MCP_ERROR,
  type DelegateTaskArgs,
  type DelegateTaskResult,
  type McpCompletionEvent,
  type McpContent,
  type McpRequestEvent,
  type McpToolCallResult,
  type McpToolSchema,
} from "./McpTypes";

const MAX_QUEUE_DEPTH = 8;

interface QueuedRequest {
  readonly id: string;
  readonly args: DelegateTaskArgs;
  readonly clientInfo?: { readonly name?: string; readonly version?: string };
  resolve: (result: DelegateTaskResult) => void;
}

export class McpToolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "McpToolError";
  }
}

export class McpHandler {
  private readonly orchestrator: AgentOrchestrator;
  private readonly queue: QueuedRequest[] = [];
  private active: QueuedRequest | null = null;
  private requestCount = 0;
  private onRequest: ((event: McpRequestEvent) => void) | null = null;
  private onCompletion: ((event: McpCompletionEvent) => void) | null = null;

  constructor(orchestrator: AgentOrchestrator) {
    this.orchestrator = orchestrator;
  }

  setOnRequest(cb: (event: McpRequestEvent) => void): void {
    this.onRequest = cb;
  }

  setOnCompletion(cb: (event: McpCompletionEvent) => void): void {
    this.onCompletion = cb;
  }

  listTools(): ReadonlyArray<McpToolSchema> {
    return [DELEGATE_TASK_TOOL];
  }

  getTotalRequests(): number {
    return this.requestCount;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
    clientInfo?: { readonly name?: string; readonly version?: string },
  ): Promise<McpToolCallResult> {
    if (name !== DELEGATE_TASK_TOOL.name) {
      throw new McpToolError(
        MCP_ERROR.METHOD_NOT_FOUND,
        `Unknown tool: ${name}`,
      );
    }

    const task = typeof args?.task === "string" ? args.task.trim() : "";
    if (!task) {
      throw new McpToolError(
        MCP_ERROR.INVALID_PARAMS,
        "delegate_task requires a non-empty `task` string argument.",
      );
    }

    const result = await this.delegate({ task }, clientInfo);
    return delegateResultToToolCallResult(result);
  }

  async delegate(
    args: DelegateTaskArgs,
    clientInfo?: { readonly name?: string; readonly version?: string },
  ): Promise<DelegateTaskResult> {
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      throw new McpToolError(
        MCP_ERROR.AGENT_BUSY,
        `Blueberry has ${this.queue.length} tasks queued and is too busy. Try again later.`,
      );
    }

    const id = uuidv4();
    this.requestCount += 1;

    const event: McpRequestEvent = {
      id,
      receivedAt: Date.now(),
      task: args.task,
      clientInfo,
    };
    this.onRequest?.(event);

    const result = await new Promise<DelegateTaskResult>((resolve) => {
      this.queue.push({ id, args, clientInfo, resolve });
      void this.drain();
    });

    this.onCompletion?.({
      id,
      completedAt: Date.now(),
      status: result.status,
      answer: result.answer,
      stepCount: result.stepCount,
      error: result.error,
    });

    return result;
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;

    try {
      const runResult = await this.orchestrator.runOneShot(next.args.task);
      const url = await this.safeGetCurrentUrl();
      const status: DelegateTaskResult["status"] =
        runResult.status === "completed"
          ? "completed"
          : runResult.status === "paused"
            ? "aborted"
            : "error";

      next.resolve({
        sessionId: runResult.sessionId,
        status,
        answer: runResult.answer,
        stepCount: runResult.steps.length,
        url,
        error: status === "error" ? runResult.answer ?? "Agent failed" : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[McpHandler] delegate_task failed:", error);
      next.resolve({
        sessionId: next.id,
        status: "error",
        answer: null,
        stepCount: 0,
        url: null,
        error: message,
      });
    } finally {
      this.active = null;
      // Tail-call the next item without blowing the stack.
      if (this.queue.length > 0) {
        setImmediate(() => {
          void this.drain();
        });
      }
    }
  }

  private async safeGetCurrentUrl(): Promise<string | null> {
    try {
      const session = this.orchestrator.getActiveSession();
      // After runOneShot resolves the active session is gone; we just return
      // null. Callers who need the URL can re-query their own state.
      if (session) return null;
      return null;
    } catch {
      return null;
    }
  }
}

function delegateResultToToolCallResult(
  result: DelegateTaskResult,
): McpToolCallResult {
  // The MCP spec models tool output as a `content` array. We emit two blocks:
  // (1) a JSON text block with the structured envelope (so callers that parse
  // it programmatically get everything), and (2) a plain-text block with the
  // answer (so models that only read text content still see the result).
  const envelope: McpContent = {
    type: "text",
    text: JSON.stringify(result, null, 2),
  };
  const answerBlock: McpContent = {
    type: "text",
    text: result.answer ?? (result.error ?? "(no answer)"),
  };
  return {
    content: [answerBlock, envelope],
    isError: result.status === "error",
  };
}
