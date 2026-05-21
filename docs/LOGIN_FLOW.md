# Login Wall Flow

> When the agent hits a sign-in page, it stops working and asks the human to
> sign in. The human clicks **"I'm signed in"** and the agent resumes.

This is a *blocking* gate, not a polling loop. There is no timeout, no
automatic recheck, no "wait 2 seconds and try again." The agent calls the
gate once, the run pauses, and the user controls when it resumes.

---

## 1. Why this exists

Earlier versions had the agent chain `screenshot → waitForApproval → wait`
when it landed on a sign-in page. Two problems with that:

1. The agent kept "passively-aggressively" cycling between screenshots and
   waits, burning tokens and confusing the user (`waitForApproval → wait →
   waitForApproval → wait → …`).
2. The `waitForApproval` UI was generic — it didn't communicate "you need
   to sign in," didn't show a clear sign-in CTA, and surfaced four decision
   buttons (Approve once / Approve all / Skip / Stop) when only one action
   is really relevant: *"I'm signed in."*

The new `loginRequired` flow makes sign-in a first-class concept with a
dedicated UI sheet, a single primary action, and an explicit channel to
the MCP delegation endpoint so outside agents know when human attention is
needed.

---

## 2. End-to-end flow

```
┌──────────────────────────────────────────────────────────────────────┐
│  1. Agent navigates to a site (e.g. web.whatsapp.com) and detects   │
│     a sign-in wall (QR code, password form, OAuth, OTP, …).          │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  2. Agent calls the loginRequired tool ONCE with:                    │
│     { app, instructions, qrLogin, url }                              │
│                                                                      │
│     The tool's execute() captures a screenshot, builds a             │
│     LoginRequiredRequest, and resolves a Promise from a `pendingLogin`│
│     entry. The runner pauses here until the Promise resolves.        │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  3. The request fans out to three places:                            │
│     a. Sidebar IPC  (agent:login-required → LoginSheet renders)      │
│     b. MCP SSE      (event: login-required → external agents see it) │
│     c. Step stream  (agent:stream-update → it appears in the step    │
│                       timeline as a `loginRequired` step)            │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  4. The user picks one of three actions in the LoginSheet:           │
│     • "I'm signed in — continue"  → decision: "signed-in"            │
│     • "Skip this app"             → decision: "skip"                 │
│     • "Stop run"                  → decision: "stop"                 │
│                                                                      │
│     The renderer invokes agent:resolve-login (id, decision).         │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  5. The Promise in McpAgentRunner.loginRequired resolves. The tool   │
│     returns fresh page context (currentUrl, pageText,                │
│     interactiveElements) + the decision. Claude then takes ONE       │
│     screenshot to confirm the wall is gone and continues the task.   │
│                                                                      │
│     If "stop" was chosen the runner aborts; "skip" continues without │
│     this app's data.                                                 │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Where the code lives

| Layer        | File                                                                         | Role                                                                  |
|--------------|------------------------------------------------------------------------------|-----------------------------------------------------------------------|
| Types        | `src/main/Agent/types/AgentTypes.ts`                                         | `LoginRequiredParams`, `LoginRequiredRequest`, `LoginDecision`        |
| Agent tool   | `src/main/Agent/mcp/McpAgentRunner.ts`                                       | `loginRequired` tool + `pendingLogin` Promise gate + `resolveLogin()` |
| Orchestrator | `src/main/Agent/core/AgentOrchestrator.ts`                                   | `setLoginCallback`, `resolveLogin`, `getPendingLogin`                 |
| IPC handler  | `src/main/Agent/core/AgentIpcHandler.ts`                                     | Multi-listener fanout                                                 |
| Routing      | `src/main/EventManager.ts`                                                   | `agent:login-required` push + `agent:resolve-login` invoke handlers   |
| MCP types    | `src/main/Mcp/McpTypes.ts`                                                   | `McpLoginRequiredEvent`                                               |
| MCP server   | `src/main/Mcp/McpServer.ts`                                                  | `broadcastLoginRequired()` over SSE                                   |
| Preload      | `src/preload/sidebar.ts` (+ `.d.ts`)                                         | `onAgentLoginRequired`, `resolveAgentLogin`, `getPendingAgentLogin`   |
| Context      | `src/renderer/sidebar/src/contexts/AgentContext.tsx`                         | `pendingLogin`, `resolveLogin`                                        |
| UI sheet     | `src/renderer/sidebar/src/components/LoginSheet.tsx`                         | Bottom-sheet modal with primary "I'm signed in" CTA                   |
| Render       | `src/renderer/sidebar/src/components/AgentPanel.tsx`                         | Takes priority over ApprovalSheet/ScriptReviewSheet                   |
| System prompt| `src/main/Agent/mcp/McpAgentRunner.ts` (`buildSystemPrompt`)                 | "SIGN-IN WALLS — USE loginRequired, NEVER POLL" section               |

---

## 4. Tool contract

```ts
loginRequired({
  app: "WhatsApp Web",          // user-visible service name
  instructions: "Scan the QR code …",
  qrLogin: true,                // optional; true for QR pair, false for password
  url: "https://web.whatsapp.com" // optional; defaults to current URL
})
```

Returns:

```ts
{
  signedIn: boolean,
  decision: "signed-in" | "skip" | "stop",
  currentUrl: string | null,
  pageText: string | null,
  interactiveElements: string | null,
  message: string,             // hint to Claude on what to do next
  stopped?: true               // present only when decision was "stop"
}
```

The tool emits a single agent step (no extra screenshot — the screenshot
was captured *inside* the tool and attached to the LoginSheet for the user
to see).

---

## 5. MCP integration

External agents that delegated the task via `delegate_task` over MCP
subscribe to the SSE stream at `GET /mcp/sse`. When the local agent hits a
login wall they receive:

```
event: login-required
data: {
  "sessionId": "…",
  "app": "WhatsApp Web",
  "instructions": "Scan the QR code …",
  "qrLogin": true,
  "url": "https://web.whatsapp.com",
  "createdAt": 1748160000000
}
```

This is **informational** — outside agents cannot resolve the gate
remotely. The human at the Blueberry desktop is the only authority for
sign-in, by design (you don't want a remote agent able to auto-approve
"continue past login wall" — that would defeat the human-in-the-loop
guarantee that Track 4 provides for destructive actions, since most
sites assume an authenticated session implies user intent).

If the user picks "Stop run" the in-flight `delegate_task` call resolves
with `status: "error"`; "Skip" continues the run; "I'm signed in" makes
the run continue normally and the outside agent eventually gets a
`completed` envelope back.

---

## 6. What the agent is taught

The system prompt in `McpAgentRunner.buildSystemPrompt()` includes a
section titled *"SIGN-IN WALLS — USE loginRequired, NEVER POLL"* that
spells out:

- Call `loginRequired` exactly once when you see a sign-in page.
- DO NOT chain `wait()` / `screenshot()` / `waitForApproval()` to poll
  for completion. The tool already blocks.
- After it returns, take ONE screenshot to confirm, then continue.
- If the user chose "Skip", note the missing data in the final answer
  and proceed to the next stage.

The old anti-pattern ("retry up to 5 times with `waitForApproval` and a
`wait(2000)` between each") has been removed from the prompt and
replaced with the single-call protocol.

---

## 7. Failure modes & recovery

| Symptom                                                                            | Cause                                                                                 | Recovery                                                                                                                                       |
|------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| Agent calls `loginRequired` but the sidebar isn't showing the sheet                | LoginSheet didn't mount (e.g. sidebar collapsed)                                      | `getPendingAgentLogin()` on AgentContext mount recovers any in-flight request — opening the sidebar re-renders the sheet.                      |
| User clicks "I'm signed in" but the page is still on the login wall                | User clicked too early (e.g. before scan completed)                                   | Agent's post-screenshot inspection re-detects the wall and calls `loginRequired` again with a sharper instruction.                             |
| Agent run is aborted while `loginRequired` is pending                              | User pressed "Stop" in AgentPanel toolbar (NOT inside the sheet)                      | `McpAgentRunner.abort()` resolves the pending login Promise with `"stop"`, the runner returns, and the session ends gracefully.                |
| External MCP agent wants to resolve the login                                      | Tries to call something like `agent:resolve-login` from outside                       | Not exposed over MCP. By design — local human only. The MCP SSE event is informational.                                                        |

---

*Last updated: 2026-05-20*
