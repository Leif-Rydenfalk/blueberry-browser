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
  DELEGATE_WORKFLOW_TOOL,
  GET_TASK_STATUS_TOOL,
  MCP_ERROR,
  STEER_TASK_TOOL,
  type DelegateTaskArgs,
  type DelegateTaskResult,
  type DelegateWorkflowArgs,
  type DelegateWorkflowResult,
  type McpAttachment,
  type McpCompletionEvent,
  type McpContent,
  type McpProgressEvent,
  type McpRequestEvent,
  type McpTaskStatusResult,
  type McpToolCallResult,
  type McpToolSchema,
  type McpWorkflowStepEvent,
} from "./McpTypes";
import type { AgentStreamUpdate } from "../Agent/types/AgentTypes";

const MAX_QUEUE_DEPTH = 8;

type ClientInfo = { readonly name?: string; readonly version?: string };

interface TaskQueueItem {
  readonly id: string;
  readonly kind: "task";
  readonly args: DelegateTaskArgs;
  readonly clientInfo?: ClientInfo;
  readonly resolve: (result: DelegateTaskResult) => void;
}

interface WorkflowQueueItem {
  readonly id: string;
  readonly kind: "workflow";
  readonly args: DelegateWorkflowArgs;
  readonly clientInfo?: ClientInfo;
  readonly resolve: (result: DelegateWorkflowResult) => void;
}

type QueueItem = TaskQueueItem | WorkflowQueueItem;

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
  private readonly queue: QueueItem[] = [];
  private active: QueueItem | null = null;
  private requestCount = 0;
  private onRequest: ((event: McpRequestEvent) => void) | null = null;
  private onCompletion: ((event: McpCompletionEvent) => void) | null = null;
  private onProgress: ((event: McpProgressEvent) => void) | null = null;
  private onWorkflowStep: ((event: McpWorkflowStepEvent) => void) | null = null;

  constructor(orchestrator: AgentOrchestrator) {
    this.orchestrator = orchestrator;
  }

  setOnRequest(cb: (event: McpRequestEvent) => void): void {
    this.onRequest = cb;
  }

  setOnCompletion(cb: (event: McpCompletionEvent) => void): void {
    this.onCompletion = cb;
  }

  setOnProgress(cb: (event: McpProgressEvent) => void): void {
    this.onProgress = cb;
  }

  setOnWorkflowStep(cb: (event: McpWorkflowStepEvent) => void): void {
    this.onWorkflowStep = cb;
  }

  listTools(): ReadonlyArray<McpToolSchema> {
    return [DELEGATE_TASK_TOOL, DELEGATE_WORKFLOW_TOOL, STEER_TASK_TOOL, GET_TASK_STATUS_TOOL];
  }

  getTotalRequests(): number {
    return this.requestCount;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
    clientInfo?: ClientInfo,
  ): Promise<McpToolCallResult> {
    if (name === DELEGATE_TASK_TOOL.name) {
      const task = typeof args?.task === "string" ? args.task.trim() : "";
      if (!task) {
        throw new McpToolError(
          MCP_ERROR.INVALID_PARAMS,
          "delegate_task requires a non-empty `task` string argument.",
        );
      }
      const attachments = parseAttachments(args?.attachments);
      const result = await this.delegate({ task, attachments }, clientInfo);
      return delegateResultToToolCallResult(result);
    }

    if (name === DELEGATE_WORKFLOW_TOOL.name) {
      if (!Array.isArray(args?.steps) || (args.steps as unknown[]).length < 2) {
        throw new McpToolError(
          MCP_ERROR.INVALID_PARAMS,
          "delegate_workflow requires a `steps` array with at least 2 entries.",
        );
      }
      const wfArgs: DelegateWorkflowArgs = {
        steps: args.steps as DelegateWorkflowArgs["steps"],
        context: typeof args.context === "string" ? args.context : undefined,
        attachments: parseAttachments(args?.attachments),
      };
      const result = await this.delegateWorkflow(wfArgs, clientInfo);
      return workflowResultToToolCallResult(result);
    }

    if (name === STEER_TASK_TOOL.name) {
      const message =
        typeof args?.message === "string" ? args.message.trim() : "";
      if (!message) {
        throw new McpToolError(
          MCP_ERROR.INVALID_PARAMS,
          "steer_task requires a non-empty `message` string.",
        );
      }
      const queued = this.orchestrator.steerAgent(message);
      const statusResult: McpTaskStatusResult & { queued: boolean; message: string } = {
        active: this.orchestrator.isRunning(),
        queued,
        message: queued
          ? "Steering message queued — agent will see it in its next tool result."
          : "No agent currently running. Message discarded.",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(statusResult, null, 2) }],
        isError: false,
      };
    }

    if (name === GET_TASK_STATUS_TOOL.name) {
      const session = this.orchestrator.getActiveSession();
      const result: McpTaskStatusResult = session
        ? {
            active: true,
            taskId: this.active?.id,
            sessionId: session.id,
            status: session.status,
            goal: session.goal,
            stepNum: session.currentStep,
            maxSteps: session.maxSteps,
            elapsedMs: Date.now() - session.createdAt,
            startedAt: session.createdAt,
            queueDepth: this.queue.length,
          }
        : { active: false, queueDepth: this.queue.length };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
      };
    }

    throw new McpToolError(MCP_ERROR.METHOD_NOT_FOUND, `Unknown tool: ${name}`);
  }

  async delegate(
    args: DelegateTaskArgs,
    clientInfo?: ClientInfo,
  ): Promise<DelegateTaskResult> {
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      throw new McpToolError(
        MCP_ERROR.AGENT_BUSY,
        `Blueberry has ${this.queue.length} tasks queued and is too busy. Try again later.`,
      );
    }

    const id = uuidv4();
    this.requestCount += 1;

    const event: McpRequestEvent = { id, receivedAt: Date.now(), task: args.task, clientInfo };
    this.onRequest?.(event);

    const result = await new Promise<DelegateTaskResult>((resolve) => {
      this.queue.push({ id, kind: "task", args, clientInfo, resolve });
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

  async delegateWorkflow(
    args: DelegateWorkflowArgs,
    clientInfo?: ClientInfo,
  ): Promise<DelegateWorkflowResult> {
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      throw new McpToolError(
        MCP_ERROR.AGENT_BUSY,
        `Blueberry has ${this.queue.length} tasks queued and is too busy. Try again later.`,
      );
    }

    const id = uuidv4();
    this.requestCount += 1;

    const summaryTask = `[workflow: ${args.steps.map((s) => s.name).join(" → ")}]`;
    const event: McpRequestEvent = { id, receivedAt: Date.now(), task: summaryTask, clientInfo };
    this.onRequest?.(event);

    const result = await new Promise<DelegateWorkflowResult>((resolve) => {
      this.queue.push({ id, kind: "workflow", args, clientInfo, resolve });
      void this.drain();
    });

    const completedCount = result.steps.filter((s) => s.status === "completed").length;
    this.onCompletion?.({
      id,
      completedAt: Date.now(),
      status: result.status === "completed" ? "completed" : "error",
      answer: result.finalAnswer,
      stepCount: result.totalStepCount,
      error: result.error,
    });

    // Satisfy TS — completedCount is referenced in the completion log
    void completedCount;

    return result;
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;

    try {
      if (next.kind === "task") {
        await this.executeTask(next);
      } else {
        await this.executeWorkflow(next);
      }
    } finally {
      this.active = null;
      if (this.queue.length > 0) {
        setImmediate(() => void this.drain());
      }
    }
  }

  private buildStepCallback(
    taskId: string,
  ): ((update: AgentStreamUpdate) => void) | undefined {
    if (!this.onProgress) return undefined;
    const emit = this.onProgress;
    return (update: AgentStreamUpdate) => {
      emit({
        taskId,
        sessionId: update.sessionId,
        stepNum: update.step,
        maxSteps: update.totalSteps,
        actionType: update.action.type,
        reasoning: (update.action.reasoning as string | undefined) ?? "",
        status: update.status === "running" ? "running"
          : update.status === "error" ? "error"
          : "success",
        currentUrl: null,
        timestamp: Date.now(),
      });
    };
  }

  private async executeTask(item: TaskQueueItem): Promise<void> {
    try {
      const goal = enrichGoalWithAttachments(item.args.task, item.args.attachments);
      const stepCallback = this.buildStepCallback(item.id);
      const runResult = await this.orchestrator.runOneShot(goal, undefined, stepCallback);
      const status: DelegateTaskResult["status"] =
        runResult.status === "completed"
          ? "completed"
          : runResult.status === "paused"
            ? "aborted"
            : "error";

      item.resolve({
        sessionId: runResult.sessionId,
        status,
        answer: runResult.answer,
        stepCount: runResult.steps.length,
        url: null,
        error: status === "error" ? (runResult.answer ?? "Agent failed") : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[McpHandler] delegate_task failed:", error);
      item.resolve({
        sessionId: item.id,
        status: "error",
        answer: null,
        stepCount: 0,
        url: null,
        error: message,
      });
    }
  }

  private async executeWorkflow(item: WorkflowQueueItem): Promise<void> {
    try {
      const context = item.args.attachments && item.args.attachments.length > 0
        ? [
            item.args.context ?? "",
            enrichGoalWithAttachments("", item.args.attachments).trim(),
          ]
            .filter(Boolean)
            .join("\n\n")
        : item.args.context;
      const stepCallback = this.buildStepCallback(item.id);

      // Emit a workflow-step SSE event after each step so callers get partial
      // answers in real time rather than waiting for the full HTTP response.
      const totalSteps = item.args.steps.length;
      const workflowStepCallback = this.onWorkflowStep
        ? (stepResult: { name: string; status: "completed" | "error" | "aborted"; answer: string | null; stepCount: number }, index: number): void => {
            this.onWorkflowStep!({
              taskId: item.id,
              workflowStepName: stepResult.name,
              workflowStepIndex: index,
              totalWorkflowSteps: totalSteps,
              status: stepResult.status,
              answer: stepResult.answer,
              agentStepCount: stepResult.stepCount,
              completedAt: Date.now(),
            });
          }
        : undefined;

      const result = await this.orchestrator.runWorkflow(
        item.args.steps,
        context,
        stepCallback,
        workflowStepCallback,
      );
      item.resolve(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[McpHandler] delegate_workflow failed:", error);
      item.resolve({
        workflowId: item.id,
        status: "error",
        steps: [],
        finalAnswer: null,
        totalStepCount: 0,
        error: message,
      });
    }
  }
}

function parseAttachments(
  raw: unknown,
): ReadonlyArray<McpAttachment> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const valid: McpAttachment[] = [];
  for (const item of raw as unknown[]) {
    if (item && typeof item === "object") {
      const a = item as Record<string, unknown>;
      if (
        (a.type === "url" || a.type === "file") &&
        typeof a.name === "string"
      ) {
        valid.push({
          type: a.type,
          name: a.name,
          url: typeof a.url === "string" ? a.url : undefined,
          content: typeof a.content === "string" ? a.content : undefined,
          mimeType: typeof a.mimeType === "string" ? a.mimeType : undefined,
        });
      }
    }
  }
  return valid.length > 0 ? valid : undefined;
}

function enrichGoalWithAttachments(
  goal: string,
  attachments?: ReadonlyArray<McpAttachment>,
): string {
  if (!attachments || attachments.length === 0) return goal;
  const parts: string[] = goal ? [goal, ""] : [];
  const urls = attachments.filter((a) => a.type === "url" && a.url);
  const files = attachments.filter((a) => a.type === "file");
  if (urls.length > 0) {
    parts.push(
      "Attached URLs (navigate to these as part of the task):\n" +
        urls.map((a) => `- ${a.name}: ${a.url}`).join("\n"),
    );
  }
  if (files.length > 0) {
    parts.push(
      "Attached files (use this content as context):\n" +
        files
          .map((a) => `--- ${a.name} ---\n${a.content ?? "(no content)"}`)
          .join("\n\n"),
    );
  }
  return parts.join("\n");
}

function delegateResultToToolCallResult(
  result: DelegateTaskResult,
): McpToolCallResult {
  const envelope: McpContent = {
    type: "text",
    text: JSON.stringify(result, null, 2),
  };
  const answerBlock: McpContent = {
    type: "text",
    text: result.answer ?? result.error ?? "(no answer)",
  };
  return {
    content: [answerBlock, envelope],
    isError: result.status === "error",
  };
}

function workflowResultToToolCallResult(
  result: DelegateWorkflowResult,
): McpToolCallResult {
  const envelope: McpContent = {
    type: "text",
    text: JSON.stringify(result, null, 2),
  };
  const stepsText = result.steps
    .map((s) => `[${s.name}] ${s.answer ?? s.error ?? "(no answer)"}`)
    .join("\n\n");
  const summary = result.finalAnswer ?? (stepsText || "(no answer)");
  const answerBlock: McpContent = { type: "text", text: summary };
  return {
    content: [answerBlock, envelope],
    isError: result.status === "error",
  };
}
