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
| `GET`  | `/mcp/sse`        | Server-Sent Events stream — live per-step progress |
| `GET`  | `/healthz`        | Liveness probe — returns `{ ok: true }` |

#### SSE event types

| `event:` | Payload | Description |
|----------|---------|-------------|
| `request` | `McpRequestEvent` | Task received and queued |
| `progress` | `McpProgressEvent` | One event per agent action — fires continuously during execution |
| `complete` | `McpCompletionEvent` | Full task finished — carries the final answer |
| `login-required` | `McpLoginRequiredEvent` | Agent hit a login wall, blocked until human signs in |

`progress` events fire for every individual agent action (navigate, click, extractSchema, etc.) and
carry the `taskId` so you can correlate with the original request. For multi-app tasks you can watch
`actionType` and `reasoning` to track which app the agent is currently working in.

A caller that only wants the final answer can ignore SSE and just `POST /mcp`
with `tools/call`.

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

## The Tool Surface

### `steer_task` — redirect the running agent

Non-blocking. Queues a plain-English instruction that the running agent
sees in its next tool result. Use it to correct a mistake, add context,
change scope, or tell the agent to stop and finish.

```jsonc
{
  "tool": "steer_task",
  "arguments": {
    "message": "You have enough speakers. Stop collecting more and write the Notion shortlist now."
  }
}
```

Returns immediately — does not wait for the agent to act on the message.
If no agent is running, `queued: false` is returned and the message is
discarded.

---

### `get_task_status` — inspect the running agent

Poll the current agent state without blocking. Useful for orchestrators
that want to check progress before deciding whether to steer. Subscribe to
`/mcp/sse` instead if you need real-time updates.

```jsonc
{
  "tool": "get_task_status",
  "arguments": {}
}
```

Returns:

```jsonc
{
  "active":      true,
  "sessionId":   "uuid",
  "status":      "running",
  "goal":        "Open Gmail and summarise ...",
  "stepNum":     14,
  "maxSteps":    60,
  "elapsedMs":   47000,
  "startedAt":   1716300000000,
  "queueDepth":  0
}
```

---

### `delegate_task` — the single delegation primitive

Use this for everything — single-app tasks, multi-app pipelines, and cross-app workflows.
The Blueberry agent handles all sequencing internally within one browser session and returns a
single combined answer at the end. You do not need to decompose the task into steps.

```jsonc
{
  "name": "delegate_task",
  "description": "Delegate any web-UI task to Blueberry Browser. Handles single-app and multi-app workflows natively. Use plain English — describe the full job and the agent sequences it internally.",
  "inputSchema": {
    "type": "object",
    "required": ["task"],
    "properties": {
      "task": {
        "type": "string",
        "description": "Plain-English instruction for the full job. Single-app: \"Send a Gmail to alice@example.com with body ...\". Multi-app: \"Check Gmail and Google Calendar for today, then send a summary to my WhatsApp +46729782220\"."
      },
      "attachments": {
        "type": "array",
        "description": "Optional URLs to navigate to or file content to use as context.",
        "items": {
          "type": "object",
          "required": ["type", "name"],
          "properties": {
            "type":     { "type": "string", "enum": ["url", "file"] },
            "name":     { "type": "string" },
            "url":      { "type": "string" },
            "content":  { "type": "string" },
            "mimeType": { "type": "string" }
          }
        }
      }
    }
  }
}
```

Output envelope:

```jsonc
{
  "sessionId": "uuid",
  "status":    "completed" | "error" | "aborted",
  "answer":    "string | null",   // combined answer covering all apps in the task
  "stepCount": 24,
  "url":       null,
  "error":     "string | undefined"
}
```

#### Example — daily attention brief

```jsonc
{
  "tool": "delegate_task",
  "arguments": {
    "task": "Open Gmail (https://mail.google.com) and summarise the 10 most recent unread emails: sender, subject, urgency. Then open Google Calendar (https://calendar.google.com) and list all events for today and tomorrow. Return a single combined 'What Needs My Attention Today' brief."
  }
}
```

#### Example — meeting prep pipeline

```jsonc
{
  "tool": "delegate_task",
  "arguments": {
    "task": "Open Google Calendar and find tomorrow's meetings. For each external attendee (non-company email), find their LinkedIn profile and note their current title and recent activity. Then open Notion (https://notion.so) and create a new page titled 'Meeting Prep - [date]' with a briefing for each attendee."
  }
}
```

#### Example — lead enrichment

```jsonc
{
  "tool": "delegate_task",
  "arguments": {
    "task": "Open the Google Sheet at https://docs.google.com/spreadsheets/d/[ID]. Extract all rows (name in column A, company in column B). For each row, search LinkedIn for their profile URL and current job title. Then return to the sheet and fill in LinkedIn URL (column C) and job title (column D) for each row."
  }
}
```

---

## SSE Event Schemas

### `progress` — per-step trace

```jsonc
{
  "taskId":      "uuid",        // correlates with request/complete events
  "sessionId":   "uuid",        // agent session ID
  "stepNum":     14,            // 1-based counter
  "maxSteps":    60,            // step budget for this run
  "actionType":  "extractSchema",
  "reasoning":   "gmail_inbox_list now has 48 rows — Gmail ✓. Navigating to Calendar next.",
  "status":      "success",     // "running" | "success" | "error"
  "currentUrl":  null,
  "timestamp":   1716300047000
}
```

Watch `actionType` and `reasoning` to track which app the agent is currently working in during
multi-app tasks. Watch `status: "error"` on repeated steps and consider calling `steer_task` to
redirect. Watch `stepNum / maxSteps` to know how much budget remains.

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

*Last updated: 2026-05-21*
