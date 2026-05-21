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
| `progress` | `McpProgressEvent` | One event per agent step — fires continuously during execution |
| `complete` | `McpCompletionEvent` | Task finished — carries the final answer |
| `login-required` | `McpLoginRequiredEvent` | Agent hit a login wall, blocked until human signs in |

`progress` events are the primary traceability mechanism. Each one carries the
step number, action type, agent reasoning, and current status so the calling
agent can track execution, detect when partial data is usable, and decide
whether to steer the agent via `steer_task`.

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

### `delegate_task` — single-step delegation

```jsonc
{
  "name": "delegate_task",
  "description": "Delegate a web-UI task to Blueberry Browser. Executed in a real browser as if a human were doing it. Use natural language.",
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

Output envelope:

```jsonc
{
  "sessionId": "uuid",
  "status":    "completed" | "error" | "aborted",
  "answer":    "string | null",
  "stepCount": 12,
  "url":       "https://final.url",
  "error":     "string | undefined"
}
```

---

### `delegate_workflow` — multi-step, cross-app delegation

Use this when a task requires sequential work across multiple applications —
each step's answer is automatically injected as context into later steps.

```jsonc
{
  "name": "delegate_workflow",
  "description": "Execute a structured multi-step workflow across multiple web apps. Steps run sequentially; earlier results are passed as context to later steps.",
  "inputSchema": {
    "type": "object",
    "required": ["steps"],
    "properties": {
      "steps": {
        "type": "array",
        "minItems": 2,
        "maxItems": 10,
        "items": {
          "type": "object",
          "required": ["name", "task"],
          "properties": {
            "name":      { "type": "string", "description": "Step identifier, e.g. 'gmail', 'calendar', 'synthesis'" },
            "task":      { "type": "string", "description": "Plain-English instruction" },
            "dependsOn": { "type": "array", "items": { "type": "string" }, "description": "Step names to inject as context (default: all previous steps)" }
          }
        }
      },
      "context": { "type": "string", "description": "Optional shared background for all steps" }
    }
  }
}
```

Output envelope:

```jsonc
{
  "workflowId":      "uuid",
  "status":          "completed" | "partial" | "error",
  "steps": [
    { "name": "gmail",    "status": "completed", "answer": "...", "stepCount": 12 },
    { "name": "calendar", "status": "completed", "answer": "...", "stepCount": 8  },
    { "name": "synthesis","status": "completed", "answer": "...", "stepCount": 4  }
  ],
  "finalAnswer":     "string | null",   // last completed step's answer
  "totalStepCount":  24,
  "error":           "string | undefined"
}
```

`status` is `"partial"` when at least one step succeeded but not all — the
workflow continues through failures so later synthesis steps can work with
partial data.

#### Example — daily attention brief

```jsonc
{
  "tool": "delegate_workflow",
  "arguments": {
    "context": "User: Leif. Company: Acme Corp. Today is 2026-05-20.",
    "steps": [
      {
        "name": "gmail",
        "task": "Open Gmail at https://mail.google.com. If not logged in use waitForApproval. Summarise the 10 most recent unread emails: sender, subject, one-line summary, urgency (high/medium/low)."
      },
      {
        "name": "calendar",
        "task": "Open Google Calendar at https://calendar.google.com. If not logged in use waitForApproval. List all events for today and tomorrow: time, title, attendees."
      },
      {
        "name": "synthesis",
        "task": "Using the Gmail and Calendar summaries provided in your context, write a 'What Needs My Attention Today' brief with sections: Urgent Emails, Meetings Today, Meetings Tomorrow, Action Items.",
        "dependsOn": ["gmail", "calendar"]
      }
    ]
  }
}
```

#### Example — meeting prep pipeline

```jsonc
{
  "steps": [
    {
      "name": "calendar",
      "task": "Open Google Calendar tomorrow's view. List external attendees (non-company email domains) for each meeting."
    },
    {
      "name": "linkedin",
      "task": "For each external attendee found in the context, search LinkedIn for their profile. Extract: current title, company, recent posts or activity. Use waitForApproval if login is needed."
    },
    {
      "name": "prep-doc",
      "task": "Using the calendar and LinkedIn data in context, write a one-page prep document in Notion (https://notion.so). Create a new page titled 'Meeting Prep - [date]'. For each attendee include: name, title, talking points, recent context."
    }
  ]
}
```

#### Example — lead enrichment

```jsonc
{
  "steps": [
    {
      "name": "sheet-read",
      "task": "Open the Google Sheet at https://docs.google.com/spreadsheets/d/[ID]. Extract all rows with name and company (columns A and B). Use waitForApproval if login is needed."
    },
    {
      "name": "linkedin-enrich",
      "task": "For each lead in the context, search LinkedIn for their profile URL and current job title. Work through the list row by row."
    },
    {
      "name": "sheet-write",
      "task": "Return to the Google Sheet. Fill in the LinkedIn URL (column C) and job title (column D) for each row using the data found in the previous step."
    }
  ]
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
  "reasoning":   "gmail_inbox_list now has 48 rows — Gmail ✓. Calendar still pending.",
  "status":      "success",     // "running" | "success" | "error"
  "currentUrl":  null,
  "timestamp":   1716300047000
}
```

The calling agent should watch for `status: "error"` on repeated steps and
consider calling `steer_task` to redirect. Watch `stepNum / maxSteps` to
know how much budget remains.

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
