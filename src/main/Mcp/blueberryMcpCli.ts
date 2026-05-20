// Stdio bridge for Blueberry's MCP server.
//
// External agent frameworks (Claude Desktop, Cline, etc.) typically expect
// MCP servers as child processes they spawn and talk to over stdio. Blueberry
// itself lives in the Electron main process and can't easily become a child
// process, so this CLI ships as a tiny adapter the agents launch instead. It
// reads newline-delimited JSON-RPC from stdin and forwards each request to
// the running Blueberry HTTP+SSE server, writing responses back to stdout.
//
// Usage (agent config):
//   {
//     "command": "node",
//     "args": ["/path/to/blueberry-browser/out/mcp-stdio.js"],
//     "env": { "BLUEBERRY_MCP_URL": "http://127.0.0.1:7777" }
//   }
//
// All logs go to stderr; stdout is reserved for the JSON-RPC stream.

import { createInterface } from "node:readline";

const SERVER_URL = (
  process.env.BLUEBERRY_MCP_URL ?? "http://127.0.0.1:7777"
).replace(/\/+$/, "");

const ENDPOINT = `${SERVER_URL}/mcp`;

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function log(...args: unknown[]): void {
  console.error("[blueberry-mcp-stdio]", ...args);
}

function writeMessage(msg: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function forward(message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
  // Notifications (no id) get no response. Forward fire-and-forget; if the
  // server is down we just log and move on.
  const isNotification = message.id === undefined || message.id === null;

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });

    if (isNotification) {
      // Server returns 204 with no body for notifications.
      return null;
    }

    if (!res.ok && res.status !== 200) {
      const text = await res.text();
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: {
          code: -32603,
          message: `Blueberry returned HTTP ${res.status}: ${text.slice(0, 200)}`,
        },
      };
    }

    const body = (await res.json()) as JsonRpcMessage;
    return body;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`forward failed: ${reason}`);
    if (isNotification) return null;
    return {
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: {
        code: -32002, // SERVER_UNREACHABLE
        message: `Cannot reach Blueberry Browser at ${SERVER_URL}. Is it running? (${reason})`,
      },
    };
  }
}

async function main(): Promise<void> {
  log(`bridging stdio → ${SERVER_URL}`);

  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
      return;
    }

    void forward(parsed).then((response) => {
      if (response) writeMessage(response);
    });
  });

  rl.once("close", () => {
    log("stdin closed, exiting");
    process.exit(0);
  });
}

void main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
