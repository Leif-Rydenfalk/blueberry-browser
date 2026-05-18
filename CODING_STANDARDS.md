# Blueberry Browser Engineering Standards

> *"Code is read 100x more than it's written. Write for the reader 6 months from now."*

---

## 1. Architecture Philosophy

### 1.1 Layered Responsibility
Every module lives in exactly one layer. No layer skipping.

```
┌─────────────────────────────────────────┐
│  Renderer (React)                       │  UI, user events, display state
│  ├─ topbar/                             │
│  ├─ sidebar/                            │
│  └─ common/                             │  Shared hooks, components, utils
├─────────────────────────────────────────┤
│  Preload (Bridge)                       │  IPC type contracts, API exposure
│  ├─ topbar.ts / topbar.d.ts             │
│  └─ sidebar.ts / sidebar.d.ts           │
├─────────────────────────────────────────┤
│  Main (Electron)                        │  Business logic, state, LLM, agents
│  ├─ Window.ts                           │  Window composition (TopBar + SideBar + Tabs)
│  ├─ Tab.ts                              │  Web content lifecycle
│  ├─ TopBar.ts / SideBar.ts              │  View containers
│  ├─ LLMClient.ts                        │  LLM abstraction (provider-agnostic)
│  ├─ Agent/                              │  ⭐ Agent system (see §5)
│  ├─ EventManager.ts                     │  IPC routing (thin, no business logic)
│  └─ Menu.ts                             │  Native menus
└─────────────────────────────────────────┘
```

**Rule:** Renderer never calls Electron APIs directly. Always via preload bridge.
**Rule:** Main process never imports renderer code. Shared types live in `src/shared/` (create if needed).

### 1.2 Dependency Direction
Dependencies flow downward. A lower layer never imports from a layer above it.

```
Renderer ──depends──> Preload ──depends──> Main
```

---

## 2. Naming & File Organization

### 2.1 Naming Conventions

| Entity | Pattern | Example |
|--------|---------|---------|
| Class | PascalCase, noun | `AgentOrchestrator`, `TabManager` |
| Interface | PascalCase, descriptive | `AgentAction`, `StreamChunk` |
| Type alias | PascalCase | `LLMProvider`, `ActionType` |
| Function | camelCase, verb | `sendChatMessage`, `executeAction` |
| Boolean | camelCase, prefix `is/has/can` | `isVisible`, `hasContext` |
| Private method | camelCase, underscore prefix discouraged; use `private` keyword | `private compileWorkflow()` |
| Constant | SCREAMING_SNAKE_CASE | `MAX_CONTEXT_LENGTH`, `DEFAULT_TEMPERATURE` |
| IPC channel | kebab-case, domain-prefixed | `agent:execute-action`, `sidebar-chat-message` |
| File name | PascalCase for classes, camelCase for utilities | `AgentRunner.ts`, `utils.ts` |

### 2.2 File Organization

```
src/
  main/
    Agent/
      core/
        AgentOrchestrator.ts      # Entry point, session management
        AgentRunner.ts            # Single-run execution loop
        ActionExecutor.ts         # Browser action execution
      types/
        AgentTypes.ts             # All interfaces, enums, schemas
      prompts/
        systemPrompts.ts          # LLM prompt templates
      strategies/
        SingleTabStrategy.ts      # Current: one active tab
        # MultiTabStrategy.ts     # Future: parallel tab access
        # HeadlessStrategy.ts     # Future: no UI, backend only
      tools/
        BrowserTool.ts            # Click, type, scroll, navigate
        ExtractionTool.ts         # DOM extraction, screenshot
      memory/
        WorkflowMemory.ts         # Save/load successful runs
    LLMClient.ts                  # Unchanged: generic LLM interface
    EventManager.ts               # Routes only, delegates to handlers
  renderer/
    sidebar/
      components/
        AgentPanel.tsx            # Agent UI overlay
        Chat.tsx                  # Existing chat
  shared/                         # Cross-layer types (create)
    agent.types.ts                # Shared Agent types
```

---

## 3. TypeScript Standards

### 3.1 Strictness
- `strict: true` everywhere. No `any` without explicit `// eslint-disable-next-line @typescript-eslint/no-explicit-any` + justification comment.
- Prefer `unknown` over `any` for catch blocks.
- Explicit return types on all public methods.

### 3.2 Immutability
- Prefer `readonly` arrays and objects.
- Use spread for state updates: `[...old, newItem]` not `old.push(newItem)`.
- No mutation of parameters.

### 3.3 Error Handling
- All async functions must handle errors at the boundary.
- Use Result/Either pattern for complex flows (or at minimum, never throw unhandled).
- Log with context: `console.error('[AgentRunner] Failed to execute click:', error)`.

### 3.4 Example Pattern

```typescript
// ✅ Good
export interface AgentAction {
  readonly type: ActionType;
  readonly params: Record<string, unknown>;
  readonly reasoning?: string;  // LLM's thought process
}

export type ActionResult = 
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: string; readonly recoverable: boolean };

export class ActionExecutor {
  async execute(action: AgentAction): Promise<ActionResult> {
    try {
      const result = await this.dispatch(action);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[ActionExecutor] ${action.type} failed:`, message);
      return { 
        success: false, 
        error: message, 
        recoverable: this.isRecoverable(action.type, message) 
      };
    }
  }
  
  private isRecoverable(type: ActionType, error: string): boolean {
    // Recovery logic centralized
    return !error.includes('navigation') && !error.includes('destroyed');
  }
}
```

---

## 4. IPC Contracts

### 4.1 Channel Naming
Format: `[domain]:[verb]-[noun]` or kebab-case for legacy.

New agent channels:
- `agent:start-session` — Begin agent run
- `agent:execute-step` — Execute single action (internal)
- `agent:pause-session` — Pause execution
- `agent:abort-session` — Cancel execution
- `agent:stream-update` — Progress updates to renderer
- `agent:session-complete` — Final result

### 4.2 Type Safety
Every IPC channel must have a corresponding interface in preload `.d.ts`:

```typescript
// preload/sidebar.d.ts
interface AgentSessionRequest {
  readonly goal: string;
  readonly context?: {
    readonly pageUrl: string | null;
    readonly pageText: string | null;
  };
  readonly mode: 'single-tab' | 'multi-tab';  // Extensible
}

interface AgentStreamUpdate {
  readonly step: number;
  readonly totalSteps: number;
  readonly action: AgentAction;
  readonly status: 'pending' | 'running' | 'success' | 'error';
  readonly result?: ActionResult;
  readonly screenshot?: string;  // Base64 after each action
}
```

### 4.3 Handler Registration
EventManager stays thin. It delegates to dedicated handlers:

```typescript
// EventManager.ts — routing only
private setupAgentHandlers(): void {
  const agentHandler = new AgentIpcHandler(this.mainWindow);
  
  ipcMain.handle('agent:start-session', (_, req) => agentHandler.start(req));
  ipcMain.handle('agent:abort-session', () => agentHandler.abort());
  
  // Events (one-way) for streaming
  agentHandler.on('update', (update) => {
    this.mainWindow.sidebar.view.webContents.send('agent:stream-update', update);
  });
}
```

---

## 5. Agent System Architecture

### 5.1 Design Goals
1. **Backend-ready**: Core logic has zero Electron UI dependencies. Could run in a worker thread tomorrow.
2. **Strategy pattern**: Tab access model is pluggable (single-tab → multi-tab → headless).
3. **Observable**: Every step emits structured events. UI is just a subscriber.
4. **Recoverable**: Failed steps can retry, skip, or pause for user input.

### 5.2 Core Abstractions

```typescript
// Agent/types/AgentTypes.ts

export type ActionType = 
  | 'navigate' 
  | 'click' 
  | 'type' 
  | 'scroll' 
  | 'wait' 
  | 'extract' 
  | 'screenshot'
  | 'finish';  // Signals completion

export interface AgentAction {
  readonly type: ActionType;
  readonly params: ActionParamsMap[ActionType];
  readonly reasoning: string;  // LLM explains why
}

export type ActionParamsMap = {
  navigate: { url: string };
  click: { selector: string; x?: number; y?: number };  // selector preferred, coords fallback
  type: { selector: string; text: string; clearFirst?: boolean };
  scroll: { direction: 'up' | 'down' | 'to-element'; amount?: number; selector?: string };
  wait: { duration?: number; condition?: 'navigation' | 'networkidle' | 'selector'; selector?: string };
  extract: { selector: string; attribute?: 'text' | 'html' | 'value'; name: string };  // name = key in result
  screenshot: {};
  finish: { answer?: string };
};

export interface AgentContext {
  readonly goal: string;
  readonly history: ReadonlyArray<AgentStep>;  // Previous actions + results
  readonly currentUrl: string | null;
  readonly pageText: string | null;
  readonly screenshot: string | null;  // Latest screenshot base64
}

export interface AgentStep {
  readonly id: string;  // uuid
  readonly timestamp: number;
  readonly action: AgentAction;
  readonly result: ActionResult;
  readonly screenshot?: string;
}

export interface AgentConfig {
  readonly maxSteps: number;
  readonly model: string;
  readonly temperature: number;
  readonly strategy: 'single-tab' | 'multi-tab';
}

// Strategy interface — the key abstraction
export interface TabStrategy {
  readonly name: string;
  getActiveContext(): Promise<AgentContext>;
  executeAction(action: AgentAction): Promise<ActionResult>;
  captureScreenshot(): Promise<string | null>;
  getPageText(): Promise<string | null>;
  getCurrentUrl(): Promise<string | null>;
}
```

### 5.3 Orchestrator Flow

```
User Goal → AgentOrchestrator.start()
                │
                ▼
    ┌───────────────────────┐
    │ 1. Capture Context    │ ← TabStrategy.getActiveContext()
    │    (screenshot + DOM) │
    └───────────────────────┘
                │
                ▼
    ┌───────────────────────┐
    │ 2. Build Prompt       │ ← system + context + history
    │    (ReAct format)     │
    └───────────────────────┘
                │
                ▼
    ┌───────────────────────┐
    │ 3. Stream to LLM      │ ← LLMClient (existing)
    │    Parse JSON action  │
    └───────────────────────┘
                │
                ▼
    ┌───────────────────────┐
    │ 4. Execute Action     │ ← TabStrategy.executeAction()
    │    Emit step event      │
    └───────────────────────┘
                │
                ▼
    ┌───────────────────────┐
    │ 5. Check finish?      │ ← action.type === 'finish' or maxSteps
    │    Yes → Save workflow │
    │    No  → Loop to 1     │
    └───────────────────────┘
```

### 5.4 ReAct Prompt Format
The LLM receives a structured prompt forcing it to think then act:

```
You are a browser automation agent. You control a web browser to achieve user goals.

Available actions (respond with JSON only):
- navigate: { "type": "navigate", "params": { "url": "..." }, "reasoning": "..." }
- click: { "type": "click", "params": { "selector": "..." }, "reasoning": "..." }
- type: { "type": "type", "params": { "selector": "...", "text": "..." }, "reasoning": "..." }
- scroll: { "type": "scroll", "params": { "direction": "down", "amount": 300 }, "reasoning": "..." }
- extract: { "type": "extract", "params": { "selector": "...", "name": "price" }, "reasoning": "..." }
- screenshot: { "type": "screenshot", "params": {}, "reasoning": "Need to see current state" }
- finish: { "type": "finish", "params": { "answer": "..." }, "reasoning": "Task complete" }

Current page: {{url}}
Page text: {{truncated_text}}
Previous actions: {{history_json}}

Goal: {{user_goal}}

Respond with exactly one JSON action object. No markdown, no explanation outside JSON.
```

---

## 6. UI Design System

### 6.1 Visual Language
- **Glassmorphism**: `backdrop-filter: blur(20px) saturate(1.6)` for overlays
- **Rounded**: `--radius: 0.75rem` consistently
- **Colors**: Blueberry palette (indigo/blue primary, slate neutrals)
- **Spacing**: 4px base unit (Tailwind default)
- **Transitions**: 150-200ms ease for interactive elements

### 6.2 Component Patterns
- All interactive elements: `cursor-pointer`, `app-region-no-drag`
- Loading states: Animated blueberry emoji 🫐 or spinner dots
- Agent step visualization: Timeline with status indicators
  - Pending: muted dot
  - Running: pulsing primary dot
  - Success: green check
  - Error: red X with retry button

### 6.3 Agent Panel Layout
```
┌─────────────────────────────┐
│ 🫐 Agent Mode          [×]  │
├─────────────────────────────┤
│ Goal: "Find cheapest flight"│
│ [▮▮▮▯▯▯] Step 2/5          │
├─────────────────────────────┤
│ ■ Navigate to google.com ✓  │
│ ● Click search box     ...   │
│ ○ Type query           wait  │
│ ○ Extract results      wait  │
├─────────────────────────────┤
│ [Pause] [Abort] [Screenshot]│
└─────────────────────────────┘
```

---

## 7. Implementation Order (MVP)

1. **Shared types** (`src/shared/agent.types.ts`) — Contracts first
2. **TabStrategy interface** + **SingleTabStrategy** implementation
3. **AgentOrchestrator** + **AgentRunner** — Core loop
4. **ActionExecutor** — DOM action dispatch
5. **System prompts** — ReAct prompt engineering
6. **IPC handlers** — Wire into EventManager
7. **Sidebar UI** — AgentPanel component
8. **WorkflowMemory** — Save successful runs (localStorage/JSON file)

---

## 8. Testing & Quality

- Every public method must have a 1-line docstring explaining *why*, not just *what*.
- No `console.log` in production code. Use `console.error` for errors, structured logging for events.
- Prefer `readonly` and immutability. If mutation is required, document why in a comment.
- Export interfaces, not concrete classes, when crossing module boundaries.

---

## 9. Future Extension Points

| Feature | Extension Point |
|---------|----------------|
| Multi-tab agent | Implement `MultiTabStrategy implements TabStrategy` |
| Headless backend | Replace `TabStrategy` with `PuppeteerStrategy` or `CDPStrategy` |
| Workflow sharing | Add `WorkflowMemory.exportToJson()` / `.importFromJson()` |
| Human-in-the-loop | Add `pause` state + `await userConfirmation()` in AgentRunner |
| Custom tools | Extend `ActionType` union + add handler in `ActionExecutor` |
| Vision models | Pass screenshot array to LLM instead of text-only context |

---

*Last updated: 2026-05-18*
*Version: 1.0 — Agent System MVP*
