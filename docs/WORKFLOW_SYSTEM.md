# Blueberry Browser — Workflow System

> Record once. Run forever. The browser learns how you work.

---

## Overview

The Workflow System lets users record their browsing sessions, annotate intent at each step, save named workflows, and replay them on demand using the AI agent. The core idea: instead of writing an agent prompt from scratch, you do the task once and let the browser remember it.

```
User browses  →  WorkflowRecorder captures navigation + screenshots
                 ↕  User adds annotations via sidebar
User saves    →  WorkflowStore persists JSON to disk
                 ↕
User runs     →  WorkflowIpcHandler.buildAgentPrompt()
              →  AgentOrchestrator executes the workflow
```

---

## File Structure

```
src/
  main/
    Workflow/
      WorkflowTypes.ts        # All interfaces, enums, IPC channel constants
      WorkflowRecorder.ts     # Hooks tab events, accumulates steps
      WorkflowStore.ts        # JSON file persistence (userData/workflows/)
      WorkflowIpcHandler.ts   # IPC handler + agent prompt builder
  renderer/
    sidebar/
      src/
        contexts/
          WorkflowContext.tsx # React state + IPC calls
        components/
          WorkflowPanel.tsx   # Full sidebar UI
```

---

## Data Model

### `WorkflowStep`

Each step has a `type` that determines the shape of `data.payload`:

| Type | Payload | Captured by |
|------|---------|-------------|
| `navigation` | `{ fromUrl, toUrl, pageTitle }` | `WorkflowRecorder` (automatic) |
| `annotation` | `{ text }` | User via sidebar (manual) |
| `screenshot` | `{ imageData: string }` | `WorkflowRecorder` (async, after navigation) |

```typescript
interface WorkflowStep {
  readonly id: string;           // uuid
  readonly timestamp: number;    // epoch ms
  readonly url: string;          // URL at capture time
  readonly pageTitle: string;
  readonly data: WorkflowStepData;
}
```

### `Workflow`

```typescript
interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: number;
  readonly duration: number;     // ms from first to last step
  readonly steps: WorkflowStep[];
  readonly startUrl: string;
  readonly endUrl: string;
  readonly stepCount: number;
}
```

### `RecordingState` (live, pushed to renderer)

```typescript
interface RecordingState {
  readonly isRecording: boolean;
  readonly startedAt: number | null;
  readonly stepCount: number;
  readonly currentUrl: string | null;
}
```

---

## WorkflowRecorder

`WorkflowRecorder` is a pure in-memory recorder with no Electron or file-system dependencies. It hooks into `webContents` navigation events on each `Tab` and captures steps.

### Navigation capture

```typescript
hookTab(tab: Tab): void  // call once per tab, on creation
```

Listens to both `did-navigate` and `did-navigate-in-page`. Deduplicates rapid same-URL events. After each navigation, fires a background screenshot and appends it as a `screenshot` step.

### Annotation capture

```typescript
addAnnotation(text: string, currentUrl: string, pageTitle: string): void
```

Called from `WorkflowIpcHandler` when the user submits a note in the sidebar during recording.

### Lifecycle

```
start()           → clears state, sets isRecording = true
stop(name)        → assembles Workflow, clears state, returns it
cancel()          → clears state without returning a Workflow
```

### Tab hooks

`WorkflowRecorder` keeps a `Map<tabId, listener>` so hooks can be cleanly removed. New tabs are hooked via `Window.setOnTabCreated()` wired in `index.ts` after `EventManager` is created.

---

## WorkflowStore

Persists workflows as individual JSON files under:
```
<userData>/workflows/<workflow-id>.json
```

`listSummaries()` reads all files and returns lightweight `WorkflowSummary` objects (no steps, no screenshot data) sorted by `createdAt` descending. Full workflows are only loaded on demand via `getWorkflow(id)`.

---

## WorkflowIpcHandler

The IPC handler ties everything together. It:
1. Owns a `WorkflowRecorder` and `WorkflowStore` instance
2. Hooks all current tabs at construction time
3. Exposes `hookNewTab(tab)` for tabs created after init
4. Implements `buildAgentPrompt(workflowId, goalOverride?)` — the key translation layer

### `buildAgentPrompt`

Converts a saved workflow into a structured natural-language prompt for the agent:

```
You are reproducing a workflow recorded by a user.

Workflow: "Process weekly LinkedIn outreach"
Originally performed: 5/19/2026, 9:00:00 AM
Duration: 240s

--- RECORDED STEPS ---
1. [09:00:12] Navigated to: https://linkedin.com/messaging
   Page: "Messaging | LinkedIn"
   📝 User note: "Start at LinkedIn messages"
2. [09:01:45] Navigated to: https://linkedin.com/messaging/thread/2-abc123
   Page: "Sarah Kim | LinkedIn"
   📝 User note: "Open recruiter messages one by one"
...
--- END OF RECORDING ---

Goal: Reproduce this workflow exactly. Start at "https://linkedin.com/messaging",
follow the same sequence of pages and actions. Use the user's notes as intent
guidance. Adapt to the current state of each page as needed.
```

The agent receives annotated navigation waypoints and treats them as an intent blueprint, not a rigid script. It can navigate to the same pages using current DOM state.

---

## IPC Channels

All channel names are defined in `WORKFLOW_CHANNELS` in `WorkflowTypes.ts`.

| Channel | Direction | Payload | Description |
|---------|-----------|---------|-------------|
| `workflow:start-recording` | invoke | → `RecordingState` | Begin recording |
| `workflow:stop-recording` | invoke | `name: string` → `Workflow \| null` | Save and stop |
| `workflow:cancel-recording` | invoke | → void | Discard current recording |
| `workflow:add-annotation` | invoke | `text: string` → `boolean` | Append annotation step |
| `workflow:get-recording-state` | invoke | → `RecordingState` | Poll current state |
| `workflow:get-all` | invoke | → `WorkflowSummary[]` | List saved workflows |
| `workflow:get-one` | invoke | `id: string` → `Workflow \| null` | Load full workflow |
| `workflow:delete` | invoke | `id: string` → `boolean` | Delete from disk |
| `workflow:rename` | invoke | `id, name` → `boolean` | Rename saved workflow |
| `workflow:execute` | invoke | `id, goalOverride?` → session info | Build prompt + start agent |
| `workflow:recording-update` | event (push) | `RecordingState` | State change notification |
| `workflow:step-captured` | event (push) | `WorkflowStep` | New step appended |

---

## Renderer Integration

### `WorkflowContext`

Wraps IPC calls in React state. The component tree subscribes to `workflow:recording-update` for live recording state. Workflows are loaded on mount and after save/delete.

### `WorkflowPanel`

Three distinct states:

**Empty state** — no saved workflows, big 🫐, "Start recording" CTA.

**Recording bar** (shown when `recording.isRecording`) — live step counter, elapsed time, current URL, "Add note" inline input, name field, Save / Discard buttons.

**Workflow list** — cards showing name, step count, duration, start → end URL. Each card has: Run (opens goal-override modal) and Delete.

### `SidebarApp` tab switcher

`Agent` and `Workflows` are top-level tabs in the sidebar. Both panels stay mounted but only the active one is visible. Both `AgentProvider` and `WorkflowProvider` wrap the whole tree.

---

## Extension Points

| Feature | Where to add |
|---------|-------------|
| Click/input capture | Inject content script in `WorkflowRecorder.hookTab()` via `executeJavaScript`; use `window.postMessage` + preload forwarding |
| Workflow sharing / import | Add `WorkflowStore.exportToJson()` + `importFromJson()` |
| Scheduled runs | Trigger `workflow:execute` from a cron-style timer in main process |
| Multi-step agent orchestration | Chain multiple `buildAgentPrompt()` calls in a pipeline |
| Workflow search / tags | Add `tags[]` to `Workflow` and filter in `WorkflowStore.listSummaries()` |
| Step screenshots in modal | Load full `Workflow` on card expand, render `screenshot` steps inline |

---

*Last updated: 2026-05-19*
