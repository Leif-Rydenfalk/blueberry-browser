# MCP Delegation — How Other Agents Talk to Blueberry

Blueberry exposes itself over the [Model Context Protocol](https://modelcontextprotocol.io)
so any other agent — Hermes, Claude projects, an n8n flow, a cron job, anything
that speaks MCP — can hand off web-UI work and await a structured result.

The agent on the other end describes the task in plain English:

> *"Message 'Hello how is it going' to Leif Adamec Rydenfalk on LinkedIn."*
> *"Send this Gmail to ledamecrydenfalk@gmail.com: <body>."*
> *"Pull the last 50 transactions from my bank dashboard into a CSV."*

Blueberry's classifier picks a step budget, the agent loop performs the task in
a real browser, and the destructive-action gate still routes through the local
human on the desktop. The caller gets back a single `{ answer, status,
sessionId, steps }` envelope.

---

## Two Transports

Both speak the same MCP JSON-RPC wire format; pick whichever fits the caller.

### 1. HTTP + SSE — for network / remote agents

Blueberry binds a localhost port at startup (default **7777**, override with
`BLUEBERRY_MCP_PORT`). Disable the server entirely with
`BLUEBERRY_MCP_ENABLED=false`.

| Method | Path              | Purpose                              |
|--------|-------------------|--------------------------------------|
| `POST` | `/mcp`            | JSON-RPC requests (`initialize`, `tools/list`, `tools/call`) |
| `GET`  | `/mcp/sse`        | Server-Sent Events stream for streamed progress updates |
| `GET`  | `/healthz`        | Liveness probe — returns `{ ok: true }` |

The SSE stream emits one event per agent step (`event: progress`) so the
caller can render live progress, plus a terminal `event: complete` carrying the
final envelope. A caller that only wants the final answer can ignore SSE and
just `POST /mcp` with `tools/call`.

### 2. stdio bridge — for local subprocess agents

A companion CLI ships as `out/mcp-stdio.js`. External agents that prefer the
classic MCP-over-stdio pattern spawn it as a child process:

```jsonc
{
  "mcpServers": {
    "blueberry": {
      "command": "node",
      "args": ["/path/to/blueberry-browser/out/mcp-stdio.js"],
      "env": { "BLUEBERRY_MCP_URL": "http://127.0.0.1:7777" }
    }
  }
}
```

The bridge translates stdio JSON-RPC into HTTP calls against the running
Blueberry instance. If Blueberry isn't running, the bridge returns a clear
`server_unreachable` error so the caller can surface it.

---

## The Tool Surface (Minimal, v1)

```jsonc
{
  "name": "delegate_task",
  "description":
    "Delegate a web-UI task to Blueberry Browser. The task is executed in a real browser as if a human were doing it. Use natural language. Returns the agent's final answer plus the session id for follow-up.",
  "inputSchema": {
    "type": "object",
    "required": ["task"],
    "properties": {
      "task": {
        "type": "string",
        "description": "Plain-English instruction. Examples: \"Message 'hi' to John Doe on LinkedIn\", \"Send a Gmail to alice@example.com with the body ...\"."
      }
    }
  }
}
```

Output envelope (the `content` block of `tools/call`'s response):

```jsonc
{
  "sessionId": "uuid",
  "status":    "completed" | "error" | "aborted",
  "answer":    "string | null",      // agent's final-step answer text
  "stepCount": 12,
  "url":       "https://final.url",  // current tab url on completion
  "error":     "string | undefined"
}
```

That's deliberately the entire surface. Workflows, tab control, dataset bulk
runs — all of that exists in the desktop UI but is *not* exposed to outside
agents in v1. The framing matches what a human delegator would say: *"do this
thing for me, tell me how it went."*

---

## Approvals Stay Local

When the running agent hits a destructive action (Send, Pay, Delete, Confirm,
…) the existing **Approval Gate** ([`ROADMAP.md` §Track 4](./ROADMAP.md#track-4--human-in-the-loop-hitl-checkpoints-shipped))
blocks until the human at the Blueberry desktop approves.

The outside caller experiences this as the SSE stream pausing and the eventual
result reflecting the human's decision. The MCP surface intentionally does
*not* allow a remote agent to auto-approve destructive actions — the human at
the machine that owns the browser session is always the source of truth for
"yes, send the email."

---

## Architecture

```
External agent (Hermes, Claude, n8n, cron, …)
        │
        │  MCP JSON-RPC over stdio OR HTTP+SSE
        ▼
┌─────────────────────────────────────────────┐
│  src/main/Mcp/                              │
│    McpServer.ts   ── HTTP + SSE listener    │
│    McpHandler.ts  ── dispatches tool calls  │
│    blueberryMcpCli.ts ── stdio bridge       │
└─────────────────────────────────────────────┘
        │
        ▼
AgentOrchestrator.runOneShot(goal)
        │
        ▼
McpAgentRunner → SingleTabStrategy → real browser
        │
        ├── ApprovalGate ──► sidebar bottom-sheet (human)
        └── streams progress back to the caller via SSE
```

`runOneShot` already exists for bulk workflow execution (each CSV row is a
one-shot run); the MCP handler reuses it as-is. No new agent code paths.

---

## Versioning & Backwards Compatibility

- The MCP server advertises `serverInfo.version` from `package.json`.
- The tool set is **additive only** until a 2.0 — new tools may appear, but
  `delegate_task`'s schema is the long-term contract.
- Protocol changes track the upstream MCP spec version; the server reports
  what it speaks during `initialize` and the bridge surfaces incompatibility
  errors clearly rather than silently mis-translating.

---

*Last updated: 2026-05-20*
