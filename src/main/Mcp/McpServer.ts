// MCP HTTP+SSE transport. External agents speak JSON-RPC 2.0 against
// POST /mcp; subscribe to live progress on GET /mcp/sse. We deliberately
// bind 127.0.0.1 only — any network exposure must wait for an auth story.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  MCP_DEFAULT_HOST,
  MCP_DEFAULT_PORT,
  MCP_ERROR,
  MCP_PROTOCOL_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpInitializeParams,
  type McpInitializeResult,
  type McpLoginRequiredEvent,
  type McpStatus,
  type McpToolCallParams,
  type McpToolsListResult,
} from "./McpTypes";
import type { LoginRequiredRequest } from "../Agent/types/AgentTypes";
import { McpHandler, McpToolError } from "./McpHandler";

interface SseClient {
  readonly id: string;
  readonly res: ServerResponse;
}

export interface McpServerOptions {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly serverName: string;
  readonly serverVersion: string;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB — generous for any sane MCP call

export class McpServer {
  private readonly handler: McpHandler;
  private readonly opts: McpServerOptions;
  private server: Server | null = null;
  private listening = false;
  private lastError: string | null = null;
  private sseClients: SseClient[] = [];
  private onStatusChanged: ((status: McpStatus) => void) | null = null;

  constructor(handler: McpHandler, opts: McpServerOptions) {
    this.handler = handler;
    this.opts = opts;

    // Fan handler events out to SSE subscribers.
    this.handler.setOnRequest((event) => {
      this.broadcast("request", event);
    });
    this.handler.setOnCompletion((event) => {
      this.broadcast("complete", event);
    });
  }

  setOnStatusChanged(cb: (status: McpStatus) => void): void {
    this.onStatusChanged = cb;
  }

  getStatus(): McpStatus {
    return {
      enabled: this.opts.enabled,
      listening: this.listening,
      host: this.opts.host,
      port: this.opts.port,
      url: `http://${this.opts.host}:${this.opts.port}`,
      totalRequests: this.handler.getTotalRequests(),
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    if (!this.opts.enabled) {
      console.log("[McpServer] Disabled via config; not starting.");
      this.emitStatus();
      return;
    }
    if (this.server) return;

    const server = createServer((req, res) => this.route(req, res));
    server.on("error", (err) => {
      console.error("[McpServer] server error:", err);
      this.lastError = err.message;
      this.listening = false;
      this.emitStatus();
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.opts.port, this.opts.host);
    }).catch((err) => {
      console.error("[McpServer] failed to listen:", err);
      this.lastError = err instanceof Error ? err.message : String(err);
      this.listening = false;
      this.emitStatus();
      throw err;
    });

    this.server = server;
    this.listening = true;
    this.lastError = null;
    console.log(
      `[McpServer] Listening on http://${this.opts.host}:${this.opts.port}`,
    );
    this.emitStatus();
  }

  // Notify subscribed external MCP clients that the active delegation is
  // blocked on a login wall. They cannot resolve it remotely (humans approve
  // sign-in locally) but they may want to surface the prompt to their UI.
  broadcastLoginRequired(request: LoginRequiredRequest): void {
    const payload: McpLoginRequiredEvent = {
      sessionId: request.sessionId,
      app: request.app,
      instructions: request.instructions,
      qrLogin: request.qrLogin,
      url: request.url,
      createdAt: request.createdAt,
    };
    this.broadcast("login-required", payload);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    // Close any open SSE streams first so the server can shut down promptly.
    for (const client of this.sseClients) {
      try {
        client.res.end();
      } catch {
        // best-effort
      }
    }
    this.sseClients = [];

    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = null;
    this.listening = false;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.onStatusChanged?.(this.getStatus());
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/healthz") {
      this.sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.startsWith("/mcp/sse")) {
      this.openSse(req, res);
      return;
    }
    if (req.method === "POST" && url.startsWith("/mcp")) {
      void this.handleJsonRpc(req, res);
      return;
    }
    this.sendJson(res, 404, { error: "not found" });
  }

  private openSse(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`: connected\n\n`);

    const id = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const client: SseClient = { id, res };
    this.sseClients.push(client);

    res.on("close", () => {
      this.sseClients = this.sseClients.filter((c) => c.id !== id);
    });
  }

  private broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.res.write(payload);
      } catch (err) {
        console.error("[McpServer] sse write failed:", err);
      }
    }
  }

  private async handleJsonRpc(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      this.sendJson(res, 413, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: MCP_ERROR.INVALID_REQUEST,
          message: err instanceof Error ? err.message : "read failed",
        },
      });
      return;
    }

    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(body) as JsonRpcRequest;
    } catch {
      this.sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: MCP_ERROR.PARSE_ERROR, message: "invalid JSON" },
      });
      return;
    }

    const response = await this.dispatch(parsed);
    // JSON-RPC notifications (no id) get no response body — but for HTTP it's
    // simpler to always return 200 with an empty body in that case.
    if (parsed.id === undefined || parsed.id === null) {
      res.writeHead(204).end();
      return;
    }
    this.sendJson(res, 200, response);
  }

  private async dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case "initialize": {
          const params = (req.params ?? {}) as McpInitializeParams;
          const result: McpInitializeResult = {
            protocolVersion: params.protocolVersion ?? MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: this.opts.serverName,
              version: this.opts.serverVersion,
            },
          };
          return { jsonrpc: "2.0", id, result };
        }

        case "notifications/initialized":
        case "initialized": {
          // Spec-mandated notification with no response.
          return { jsonrpc: "2.0", id, result: {} };
        }

        case "tools/list": {
          const result: McpToolsListResult = { tools: this.handler.listTools() };
          return { jsonrpc: "2.0", id, result };
        }

        case "tools/call": {
          const params = (req.params ?? {}) as McpToolCallParams;
          const result = await this.handler.callTool(
            params.name,
            params.arguments,
          );
          return { jsonrpc: "2.0", id, result };
        }

        case "ping": {
          return { jsonrpc: "2.0", id, result: {} };
        }

        default:
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: MCP_ERROR.METHOD_NOT_FOUND,
              message: `Unknown method: ${req.method}`,
            },
          };
      }
    } catch (err) {
      if (err instanceof McpToolError) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: err.code, message: err.message },
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error("[McpServer] dispatch error:", err);
      return {
        jsonrpc: "2.0",
        id,
        error: { code: MCP_ERROR.INTERNAL_ERROR, message },
      };
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text).toString(),
    });
    res.end(text);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => reject(err));
  });
}

export function readMcpOptionsFromEnv(serverVersion: string): McpServerOptions {
  const enabled = process.env.BLUEBERRY_MCP_ENABLED?.toLowerCase() !== "false";
  const port = parsePort(process.env.BLUEBERRY_MCP_PORT) ?? MCP_DEFAULT_PORT;
  const host = process.env.BLUEBERRY_MCP_HOST?.trim() || MCP_DEFAULT_HOST;
  return {
    enabled,
    host,
    port,
    serverName: "blueberry-browser",
    serverVersion,
  };
}

function parsePort(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return null;
  return n;
}
