# 🫐 Blueberry Browser

> A real browser that other AI agents can operate like a human.

This project started as a two-week engineering challenge set by [Strawberry](https://github.com/strawberry-browser/strawberry) — build a feature that makes Blueberry superior and more promising than Strawberry. It grew into a personal tool I actually use daily to run my businesses.

Blueberry is an Electron desktop browser with an AI agent built in. Its primary purpose is to act as the **web-action runtime** for an agentic stack — other agents (Claude projects, n8n flows, cron jobs, anything that speaks MCP) hand it natural-language tasks, and Blueberry performs them in a real, logged-in browser as if a person were sitting at the keyboard.

---

## What It Is

Most AI agents fall apart when a task requires a real browser: clicking a button behind a login wall, filling a form, reading a dashboard, sending a message in WhatsApp Web. They either use headless scraping (which sites detect and block) or bespoke API integrations (which don't exist for most tools and break when the API changes).

Blueberry solves this differently: it **is the browser**. The agent works inside Chromium, on your actual logged-in sessions, using the same DOM and UI that you use. There are no per-site integrations, no tokens to rotate, no scraping detection to avoid. If a human can do it in a browser, Blueberry can do it.

Two things distinguish it:

1. **Human-equivalent execution.** DOM clicks, real keyboard input, real form submissions — the same thing a person does.
2. **Callable endpoint.** Blueberry exposes itself over the [Model Context Protocol](https://modelcontextprotocol.io) so any other agent can delegate web-UI work to it and await a structured result. It is not just an app — it is a runtime other agents call into.

---

## How I Use It to Run My Businesses

Blueberry is wired into my daily agent stack. The pattern is always the same: an orchestrator agent (Hermes, a Claude project, a cron job) figures out what needs to happen, then delegates the web-UI steps to Blueberry via MCP. Blueberry executes them in a real browser — on my logged-in accounts — and returns a structured result.

### Gmail

Send, read, summarise, reply. The agent opens `https://mail.google.com` on my active session (already logged in), composes or reads, and returns a summary. No Gmail API, no OAuth token management — it just uses the web app the way I do.

```jsonc
{
  "tool": "delegate_task",
  "arguments": {
    "task": "Open Gmail. Summarise the 10 most recent unread emails: sender, subject, one-line summary, urgency (high/medium/low)."
  }
}
```

### WhatsApp Web

Send messages, check conversations. The first time in a session Blueberry hits the QR-code wall, it emits a `login-required` event and the sidebar asks me to scan. After that, the session stays open.

```jsonc
{
  "tool": "delegate_task",
  "arguments": {
    "task": "Open WhatsApp Web at https://web.whatsapp.com. Message 'Hey, following up on the proposal — any updates?' to the chat named 'Client Name'."
  }
}
```

> Note: WhatsApp Web chat composer sends on Enter. The agent is instructed to use Shift+Enter for newlines and only press Enter once the full message is composed.

### LinkedIn

Profile lookups, messages, connection requests. Blueberry navigates LinkedIn on my logged-in session — no LinkedIn API needed, no rate-limit tokens.

```jsonc
{
  "tool": "delegate_task",
  "arguments": {
    "task": "Search LinkedIn for 'Jane Doe' at 'Acme Corp'. Extract her current title, company, and the text of her three most recent posts."
  }
}
```

### Slack

Read channels, post updates, check threads. Slack Web works the same way as any other browser app from Blueberry's perspective.

```jsonc
{
  "tool": "delegate_task",
  "arguments": {
    "task": "Open Slack at https://app.slack.com. In the #sales channel, post: 'Deal closed with Acme Corp — kicking off onboarding Monday.'"
  }
}
```

### Multi-step workflows across apps

The real power is chaining steps. A single MCP call to `delegate_workflow` runs sequential tasks across multiple apps, passing each step's output as context to the next.

```jsonc
{
  "tool": "delegate_workflow",
  "arguments": {
    "context": "User: Leif Rydenfalk. Today is 2026-05-21.",
    "steps": [
      {
        "name": "gmail",
        "task": "Open Gmail. Summarise the 10 most recent unread emails: sender, subject, one-line summary, urgency."
      },
      {
        "name": "calendar",
        "task": "Open Google Calendar. List all events for today and tomorrow: time, title, attendees."
      },
      {
        "name": "brief",
        "task": "Using the Gmail and Calendar data in context, write a 'What Needs My Attention Today' brief with sections: Urgent Emails, Meetings Today, Meetings Tomorrow, Action Items.",
        "dependsOn": ["gmail", "calendar"]
      }
    ]
  }
}
```

Other workflows I run regularly:

- **Meeting prep**: pull tomorrow's Google Calendar attendees → enrich each on LinkedIn → write a prep doc in Notion
- **Lead enrichment**: read a Google Sheet of company names → find LinkedIn profiles → write titles back to the sheet
- **Outreach at scale**: record a message workflow once → attach a CSV of leads → bulk-run it, pausing for human approval before each send

### Human-in-the-loop gate

Blueberry never auto-fires destructive actions. Any click or keystroke whose target is a Send, Pay, Submit, Delete, or Confirm button pauses the agent and shows an approval sheet in the sidebar. I can approve once, approve all in this run, skip, or stop. Unattended overnight runs are safe because nothing irreversible happens without my explicit sign-off.

---

## MCP Interface — How Other Agents Connect

Blueberry binds an MCP server on `http://127.0.0.1:7777` at startup. Two transports:

### HTTP + SSE (network agents)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/mcp` | JSON-RPC (`initialize`, `tools/list`, `tools/call`) |
| `GET` | `/mcp/sse` | Server-Sent Events — live step-by-step progress |
| `GET` | `/healthz` | Liveness probe |

### stdio bridge (subprocess agents)

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

### Tools

| Tool | Description |
|------|-------------|
| `delegate_task` | Single natural-language task executed in the real browser |
| `delegate_workflow` | Multi-step sequential workflow across apps; earlier results injected as context into later steps |

See [`MCP_DELEGATION.md`](./MCP_DELEGATION.md) for the full schema, example payloads, and SSE event format.

---

## Architecture

```
External agent (Hermes, Claude, n8n, cron, …)
        │
        │  MCP JSON-RPC  (HTTP+SSE or stdio bridge)
        ▼
┌─────────────────────────────────────────────┐
│  Blueberry Desktop (Electron)               │
│                                             │
│  McpServer ── McpHandler                   │
│        │                                    │
│        ▼                                    │
│  AgentOrchestrator                          │
│        │                                    │
│        ▼                                    │
│  McpAgentRunner  ──────────────────────┐    │
│  (AI SDK v5, tool use, stopWhen)       │    │
│        │                               │    │
│        ▼                               ▼    │
│  SingleTabStrategy            ApprovalGate  │
│  (DOM clicks, type, scroll)   (human HITL)  │
│        │                               │    │
│        ▼                               ▼    │
│   Real Chromium tab         Sidebar UI      │
└─────────────────────────────────────────────┘
```

### Key subsystems

| Subsystem | What it does |
|-----------|-------------|
| **McpAgentRunner** | The agent loop. Uses Vercel AI SDK v5 `generateText` with tool use. Calls `navigate`, `click`, `type`, `scroll`, `extractSchema`, `waitForApproval`, `loginRequired`, `finish`. |
| **SingleTabStrategy** | Translates agent actions into real Electron `webContents` calls — DOM inspection, JS eval, screenshot, keyboard/mouse input. |
| **WorkflowRecorder** | Records DOM events (clicks, inputs, submits) from the page preload and stores them as structured steps. Replays deterministically; falls back to LLM for selector healing. |
| **ApprovalGate** | Classifies actions as destructive before execution. Blocks the runner and shows a bottom-sheet in the sidebar. |
| **LoginSheet** | First-class sign-in wall UI. Agent calls `loginRequired` once; the run blocks until the user clicks "I'm signed in". |
| **BulkRunner** | Loops a workflow over a CSV dataset, substituting column placeholders per row. Serial today; concurrent rows is a follow-up (Track 3). |

---

## Getting Started

### Prerequisites

- Node.js 20+, pnpm
- An Anthropic API key (or OpenAI / Google — all three providers are wired)
- An X display (Linux: `$DISPLAY=:1` with a virtual framebuffer is sufficient)

### Install and run

```bash
pnpm install

# Copy and fill in your API key
cp .env.example .env   # set LLM_PROVIDER=anthropic, ANTHROPIC_API_KEY=...

pnpm dev               # dev mode with hot-reload
```

### Build

```bash
pnpm build             # typecheck + electron-vite build
pnpm build:linux       # → distributable AppImage / deb
pnpm build:mac         # → .dmg
```

### Tests

```bash
pnpm test              # build + run full agent test suite (real LLM, real browser)
pnpm test:visible      # same but shows the browser window — useful for debugging

# Run a specific task by name substring
pnpm test --filter=todomvc
pnpm test --filter=lead-enrichment

# Fast compat-only tests (no LLM, no API key needed)
npx electron out/main/index.js --test --compat-only
```

See [`TESTING.md`](./TESTING.md) for the full test catalogue (18 tasks across 7 complexity tiers, including Tier 7 cross-app workflows that mirror real production delegation patterns).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `anthropic` | `anthropic`, `openai`, or `google` |
| `LLM_MODEL` | — | Model ID override (e.g. `claude-sonnet-4-6`) |
| `ANTHROPIC_API_KEY` | — | Required when provider is `anthropic` |
| `OPENAI_API_KEY` | — | Required when provider is `openai` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | — | Required when provider is `google` |
| `BLUEBERRY_MCP_PORT` | `7777` | Port for the MCP HTTP+SSE server |
| `BLUEBERRY_MCP_ENABLED` | `true` | Set to `false` to disable the MCP server |

---

## Project Files

| File | Purpose |
|------|---------|
| [`CODING_STANDARDS.md`](./CODING_STANDARDS.md) | Architecture, naming, TypeScript rules, IPC contract, adding a new feature |
| [`DESIGN.md`](./DESIGN.md) | Brand, color system, component patterns, dark mode rules |
| [`TESTING.md`](./TESTING.md) | How to run tests, task catalogue, adding new tasks, failure diagnosis |
| [`MCP_DELEGATION.md`](./MCP_DELEGATION.md) | MCP protocol, tool schemas, example payloads, SSE event format |
| [`ROADMAP.md`](./ROADMAP.md) | Shipped tracks (1–2, 4–7) and what's next (Track 3) |
| [`LOGIN_FLOW.md`](./LOGIN_FLOW.md) | Login-wall gate design, code map, failure modes |
| [`WORKFLOW_SYSTEM.md`](./WORKFLOW_SYSTEM.md) | Workflow recorder internals, bulk execution, dataset binding |

---

## What's Next

The shipped features are all in [`ROADMAP.md`](./ROADMAP.md). The one remaining track that isn't yet built:

**Track 3 — Background Execution.** Right now the agent runs in the active foreground tab — while it works, the browser is locked. The fix is spawning a hidden off-screen `WebContentsView` per run so the agent works in the background and you keep the foreground. Combined with the bulk runner this enables N parallel rows against hidden tabs without interrupting normal browsing.

Beyond that, the interesting open problems are reliability on the long tail of real sites (SPAs, iframes, anti-bot pages) and making the MCP surface stable enough that other tools can depend on it without babysitting. Both are engineering quality work more than feature work.

---

*Built by Leif Rydenfalk — ledamecrydenfalk@gmail.com*   
