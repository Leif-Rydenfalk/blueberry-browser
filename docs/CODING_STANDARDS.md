# Blueberry Browser — Engineering Standards

> Write for the reader six months from now. Make the next change easy.

---

## 1. Architecture

### Layers

```
Renderer (React)      UI, user events, display state only
     ↓ IPC
Preload (Bridge)      contextBridge exposure — types + thin wrappers
     ↓ IPC
Main (Electron)       Business logic, state, file I/O, LLM, agents
```

**Rules:**
- Renderer never imports Electron APIs directly. Everything via preload bridge.
- Main process never imports renderer code. Shared types go in `src/shared/` (create if needed).
- Dependencies flow downward. A lower layer never imports from a layer above.

### Module map

```
src/
  main/
    Agent/
      core/           AgentOrchestrator, AgentRunner, ActionExecutor, AgentIpcHandler
      types/          AgentTypes.ts — all agent interfaces/enums
      prompts/        systemPrompts.ts — LLM prompt templates
      strategies/     SingleTabStrategy (+ future MultiTab, Headless)
    Workflow/
      WorkflowTypes.ts
      WorkflowRecorder.ts
      WorkflowStore.ts
      WorkflowIpcHandler.ts
    LLMClient.ts      Provider-agnostic LLM abstraction
    EventManager.ts   IPC routing only — no business logic
    Window.ts         Window composition (TopBar + SideBar + Tabs)
    Tab.ts            Web content lifecycle
  preload/
    sidebar.ts / .d.ts
    topbar.ts / .d.ts
  renderer/
    common/           Shared hooks, components, utils
    sidebar/          Sidebar React app
    topbar/           TopBar React app
```

---

## 2. Naming Conventions

| Entity | Convention | Example |
|--------|-----------|---------|
| Class | PascalCase noun | `AgentOrchestrator`, `WorkflowStore` |
| Interface | PascalCase, descriptive | `AgentAction`, `RecordingState` |
| Type alias | PascalCase | `ActionType`, `WorkflowStepType` |
| Function / method | camelCase verb | `startRecording`, `buildAgentPrompt` |
| Boolean | camelCase, `is/has/can` prefix | `isRecording`, `canGoBack` |
| Private method | `private` keyword (no underscore prefix) | `private emitState()` |
| Constant | SCREAMING_SNAKE_CASE | `MAX_STEPS`, `WORKFLOW_CHANNELS` |
| IPC channel | kebab-case, domain-prefixed | `agent:start-session`, `workflow:stop-recording` |
| File | PascalCase for classes, camelCase for utils | `WorkflowRecorder.ts`, `utils.ts` |
| React component | PascalCase, named export | `WorkflowPanel`, `AgentPanel` |
| Props interface | `[ComponentName]Props` | `WorkflowCardProps` |

---

## 3. TypeScript

### Strictness
- `strict: true` everywhere. No `any` without `// eslint-disable-next-line @typescript-eslint/no-explicit-any` + a justification comment on the same line.
- Use `unknown` in `catch` blocks, narrow before use.
- Explicit return types on all public methods and exported functions.

### Immutability
- Prefer `readonly` on interface fields and array types.
- Spread for state updates: `[...old, newItem]` not `old.push(newItem)`.
- Never mutate parameters.

### Discriminated unions over flags
```typescript
// Good — exhaustive, compiler-checked
type WorkflowStepData =
  | { readonly type: 'navigation'; readonly payload: WorkflowNavigationData }
  | { readonly type: 'annotation'; readonly payload: WorkflowAnnotationData }
  | { readonly type: 'screenshot'; readonly payload: WorkflowScreenshotData };

// Bad — open-ended, requires runtime guards everywhere
interface WorkflowStepData {
  type: string;
  payload: unknown;
}
```

### Result pattern for fallible operations
```typescript
type ActionResult =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: string; readonly recoverable: boolean };
```

### Error handling
All async functions handle errors at the boundary. Never let unhandled rejections propagate. Log with context:
```typescript
console.error('[WorkflowRecorder] Screenshot failed:', error);
```

---

## 4. IPC Contracts

### Channel naming
Format: `[domain]:[verb]-[noun]`

Domain prefixes in use:
- `agent:` — agent session management
- `workflow:` — workflow recording and execution
- `sidebar-` — legacy chat channels (keep as-is)

### Type safety
Every IPC channel has a corresponding interface in `preload/*.d.ts`. Preload `.ts` exposes only the bridge. Types live in `.d.ts` only — never import from main process in preload.

### Handler registration
`EventManager` routes only. Business logic lives in dedicated handler classes (`AgentIpcHandler`, `WorkflowIpcHandler`):

```typescript
// EventManager — routing only
ipcMain.handle(WORKFLOW_CHANNELS.START_RECORDING, () => {
  return this.workflowHandler.startRecording();
});
```

### Grouped channel constants
Define all IPC channels as a typed const object in the domain's types file:
```typescript
export const WORKFLOW_CHANNELS = {
  START_RECORDING: 'workflow:start-recording',
  // ...
} as const;
```

---

## 5. React Patterns

### Component structure
```typescript
// Named export, explicit React.FC, props interface
interface WorkflowCardProps {
  readonly workflow: WorkflowSummary;
  readonly onExecute: () => void;
}

export const WorkflowCard: React.FC<WorkflowCardProps> = ({ workflow, onExecute }) => {
  // ...
};
```

### State management
- Local UI state: `useState` / `useReducer`.
- Cross-component state: React Context + `useReducer`. One context per domain.
- No external state library unless the codebase grows past 3 contexts.

Context pattern:
```typescript
// Always provide a clear value interface
interface WorkflowContextValue {
  recording: RecordingState;
  workflows: WorkflowSummary[];
  startRecording: () => Promise<void>;
  // ...
}

// Throw on missing provider — fail loud
export const useWorkflow = (): WorkflowContextValue => {
  const ctx = useContext(WorkflowContext);
  if (!ctx) throw new Error('useWorkflow must be used within WorkflowProvider');
  return ctx;
};
```

### Hooks
- `useCallback` for functions passed as props or used in `useEffect` deps.
- `useEffect` cleanup: always return cleanup functions for listeners.
- Avoid `useEffect` for derived state — compute it inline.

### className
Always use `cn()` from `@common/lib/utils`. Ordering: layout → spacing → sizing → colors → effects → interactive → dark variants.

```tsx
className={cn(
  "flex items-center gap-2 px-3 py-1.5",   // layout / spacing
  "h-8 rounded-xl",                          // sizing / shape
  "bg-primary/10 text-primary",              // colors
  "hover:bg-primary/20 transition-colors",   // interactive
  isActive && "ring-1 ring-primary/30"       // conditional
)}
```

No inline styles. Ever.

---

## 6. Agent System

### Strategy pattern — the key abstraction
All browser interactions go through `TabStrategy`. New execution environments (multi-tab, headless, remote) implement the same interface:

```typescript
interface TabStrategy {
  getActiveContext(goal: string, history: ReadonlyArray<AgentStep>): Promise<AgentContext>;
  executeAction(action: AgentAction): Promise<ActionResult>;
  captureScreenshot(): Promise<string | null>;
  getPageText(): Promise<string | null>;
  getCurrentUrl(): Promise<string | null>;
}
```

`SingleTabStrategy` is the only implementation today. It owns an `ActionExecutor` that translates an `AgentAction` into the underlying Electron `webContents` calls (DOM clicks, key/mouse input, JS eval, screenshots).

### Agent loop
`McpAgentRunner` is the single execution loop. It uses Vercel AI SDK v5 `generateText` with native tool use and `stopWhen` — the model emits tool calls, the runner dispatches them, and the loop continues until the model issues `finish` or a stop condition fires. The runner has zero UI dependencies — it emits step events, UI subscribes. `AgentOrchestrator` manages session lifecycle, classifies task profiles, and routes callbacks.

The system prompt is built inside the runner (`McpAgentRunner.buildSystemPrompt`). Chat-side (non-agent) prompts are built separately in `LLMClient.buildSystemPrompt`. Keep these two prompt surfaces distinct — agent context and chat context have different needs.

### Tool registry
Agent tools (the model-visible action surface) are declared in `McpAgentRunner.buildTools()`. Each tool has a Zod/JSON `inputSchema` and an `execute` closure that calls `this.runTool({ type, params, reasoning })` — which then dispatches through the strategy and executor.

### Extending actions
To add a new browser action:
1. Add the type to the `ActionType` union in `AgentTypes.ts`
2. Add its params interface and entry in `ActionParamsMap`
3. Handle it in `ActionExecutor.dispatch()`
4. Add a tool entry to `McpAgentRunner.buildTools()` — schema + `execute` that calls `runTool`
5. Update the tool description in `buildSystemPrompt` only if the model needs extra usage guidance

### Task classification
`AgentOrchestrator.classifyTask()` maps the user's goal string to an `AgentTaskProfile` which sets `maxSteps` and `maxDurationMs`. Add new profiles here rather than hardcoding numbers elsewhere.

---

## 7. Workflow System

See `WORKFLOW_SYSTEM.md` for the full architecture. Key rules:

- `WorkflowRecorder` has zero file-system or Electron UI dependencies — it receives `Tab` instances, not `Window`.
- `WorkflowStore` only reads/writes JSON. No business logic.
- `WorkflowIpcHandler` is the only class that knows about both recorder and store.
- `buildAgentPrompt()` is the translation layer. If the output prompt needs tuning, only this method changes.

---

## 8. Comments

Default: write no comments.

Write a comment only when the **why** is non-obvious — a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader:

```typescript
// Deduplicate rapid same-URL events — did-navigate fires twice on some SPAs
if (toUrl === this.lastUrl) return;

// Screenshot fires after navigation and may race with page unload
tab.screenshot().then(...).catch(err => {
  console.error('[WorkflowRecorder] Screenshot failed:', err);
});
```

Never write comments that:
- Describe what the code does (well-named identifiers do that)
- Reference the PR, issue, or task ("added for workflow recording feature")
- Summarize a block ("// loop over steps")

---

## 9. Error Handling

### Boundaries
Validate at system boundaries: user input, IPC payloads, external API responses. Trust internal method calls.

### Async
```typescript
// Good — error handled at the boundary
runner.run(goal).catch(error => {
  console.error('[AgentOrchestrator] Runner failed:', error);
  session.status = 'error';
});

// Bad — fire and forget
runner.run(goal);
```

### IPC handlers
Wrap `ipcMain.handle` callbacks in try/catch only when the error needs to be returned to renderer (e.g., workflow execution). Otherwise let Electron's IPC error propagation work.

---

## 10. File System

- App data (workflows, settings): `app.getPath('userData')`.
- Create directories with `{ recursive: true }` — idempotent.
- Never write to the project directory at runtime.

---

## 11. Logging

| Level | Use |
|-------|-----|
| `console.error('[Module] message:', error)` | Failures, unexpected states |
| `console.log('[Module] message:', data)` | Key lifecycle events (sparingly) |

No `console.log` in production paths. No debug dumps. Format: `[ClassName] verb noun: detail`.

---

## 12. Adding a New Feature

1. **Types first** — define all interfaces before writing logic. Put them in the domain's `Types.ts`.
2. **IPC channels** — add constants to `WORKFLOW_CHANNELS` / new `*_CHANNELS` object.
3. **Main logic** — implement in a dedicated handler class, no business logic in `EventManager`.
4. **Preload** — add to `sidebar.ts` (implementation) and `sidebar.d.ts` (types).
5. **Context** — add state + async calls to the relevant React context.
6. **UI** — build the component last, against the context API.
7. **Checklist** — see `DESIGN.md §13`.

---

## 13. How to see editor-equivalent type errors

`npm run typecheck` already runs both configs, but if you want to match exactly what VS Code shows:

```bash
# Node/main process types (main + preload)
npx tsc --noEmit -p tsconfig.node.json

# Web/renderer types (React components)
npx tsc --noEmit -p tsconfig.web.json
```

The root `tsconfig.json` has `"files": []` — it only references the two above. ESLint errors visible in the editor come from `.eslintrc.cjs`. Run both to get the full picture:

```bash
npm run typecheck
npx eslint src --ext .ts,.tsx --max-warnings 0
```

---

## 14. Checklist (new feature)

- [ ] `strict: true` — no `any` without justification
- [ ] All public methods have explicit return types
- [ ] All async functions handle errors at the boundary
- [ ] `readonly` on all interface fields
- [ ] IPC channels in a typed const object, mirrored in `.d.ts`
- [ ] `EventManager` only routes, handler class owns logic
- [ ] No `console.log` in production paths
- [ ] No inline styles in renderer
- [ ] Named React component export with explicit `React.FC`
- [ ] Dark mode works
- [ ] `cn()` for all className composition

---

*Last updated: 2026-05-19*
