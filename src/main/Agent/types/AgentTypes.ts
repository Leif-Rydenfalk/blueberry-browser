export type ActionType =
  | "navigate"
  | "click"
  | "type"
  | "key"
  | "scroll"
  | "wait"
  | "extract"
  | "extractSchema"
  | "executeScript"
  | "screenshot"
  | "finish"
  | "select"
  | "hover"
  | "back"
  | "forward"
  | "newTab"
  | "switchTab"
  | "closeTab"
  | "waitForSelector"
  | "waitForApproval";

export interface NavigateParams {
  readonly url: string;
}
export interface ClickParams {
  readonly selector?: string;
  readonly x?: number;
  readonly y?: number;
  readonly frame?: string;
}
export interface TypeParams {
  readonly selector?: string;
  readonly text: string;
  readonly clearFirst?: boolean;
  readonly x?: number;
  readonly y?: number;
  readonly frame?: string;
}
export interface KeyParams {
  readonly key: string;
  readonly modifiers?: ReadonlyArray<"control" | "shift" | "alt" | "meta">;
}
export interface ScrollParams {
  readonly direction: "up" | "down" | "to-element";
  readonly amount?: number;
  readonly selector?: string;
}
export interface WaitParams {
  readonly duration?: number;
  readonly condition?: "navigation" | "networkidle" | "selector";
  readonly selector?: string;
}
export interface ExtractParams {
  readonly selector: string;
  readonly attribute?: "text" | "html" | "value";
  readonly name: string;
  readonly frame?: string;
}

export interface ExtractSchemaParams {
  readonly name: string;
  readonly schema: Readonly<Record<string, string>>;
  readonly limit?: number;
  readonly containerHint?: string;
  readonly frame?: string;
}

export interface SelectParams {
  readonly selector: string;
  readonly value: string;
  readonly frame?: string;
}

export interface HoverParams {
  readonly selector?: string;
  readonly x?: number;
  readonly y?: number;
}

export interface BackParams {}
export interface ForwardParams {}

export interface NewTabParams {
  readonly url?: string;
}

export interface SwitchTabParams {
  readonly index: number;
}

export interface CloseTabParams {
  readonly index?: number;
}

export interface WaitForSelectorParams {
  readonly selector: string;
  readonly timeout?: number;
  readonly visible?: boolean;
}

export interface WaitForApprovalParams {
  readonly reason: string;
  readonly previewData?: Readonly<Record<string, unknown>>;
}

export interface ExecuteScriptParams {
  readonly script: string;
  readonly description: string;
  readonly name?: string;
}

export type ApprovalDecision = "approve-once" | "approve-all" | "skip" | "stop";

// Pre-execution gate. The agent has CHOSEN an action — we surface it to the
// human before it actually runs and let them veto / batch-approve.
export interface ApprovalRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly action: AgentAction;
  readonly reason: string;
  readonly matchedKeyword?: string;
  readonly elementLabel?: string;
  readonly previewData?: Readonly<Record<string, unknown>>;
  readonly screenshot?: string;
  readonly createdAt: number;
}

export interface ApprovalResolved {
  readonly id: string;
  readonly sessionId: string;
  readonly decision: ApprovalDecision;
  readonly resolvedAt: number;
}

export interface ScriptReviewRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly script: string;
  readonly description: string;
  readonly name?: string;
  readonly screenshot?: string;
  readonly createdAt: number;
}

export type ScriptReviewDecision = "approve" | "reject";

export interface ScriptReviewResolution {
  readonly decision: ScriptReviewDecision;
  readonly approvedScript?: string;
}

export interface TabInfo {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly url: string;
  readonly isActive: boolean;
}
export interface ScreenshotParams {}
export interface FinishParams {
  readonly answer?: string;
}
export type AgentTaskProfile =
  | "quick"
  | "repetitive"
  | "communication"
  | "research"
  | "pipeline";

// ─── Workflow types (multi-step, cross-app delegation) ────────────────────────

export interface WorkflowStep {
  readonly name: string;
  readonly task: string;
  // Names of previous steps whose answers to inject as context.
  // When omitted all previous steps' answers are injected.
  readonly dependsOn?: ReadonlyArray<string>;
}

export interface WorkflowStepResult {
  readonly name: string;
  readonly status: "completed" | "error" | "aborted";
  readonly answer: string | null;
  readonly stepCount: number;
  readonly error?: string;
}

export interface WorkflowResult {
  readonly workflowId: string;
  readonly status: "completed" | "partial" | "error";
  readonly steps: ReadonlyArray<WorkflowStepResult>;
  readonly finalAnswer: string | null;
  readonly totalStepCount: number;
  readonly error?: string;
}

export type ActionParamsMap = {
  navigate: NavigateParams;
  click: ClickParams;
  type: TypeParams;
  key: KeyParams;
  scroll: ScrollParams;
  wait: WaitParams;
  extract: ExtractParams;
  extractSchema: ExtractSchemaParams;
  screenshot: ScreenshotParams;
  finish: FinishParams;
  select: SelectParams;
  hover: HoverParams;
  back: BackParams;
  forward: ForwardParams;
  newTab: NewTabParams;
  switchTab: SwitchTabParams;
  closeTab: CloseTabParams;
  waitForSelector: WaitForSelectorParams;
  waitForApproval: WaitForApprovalParams;
  executeScript: ExecuteScriptParams;
};

export interface AgentAction {
  readonly type: ActionType;
  readonly params: ActionParamsMap[ActionType];
  readonly reasoning: string;
}

export type ActionResult =
  | { readonly success: true; readonly data: unknown }
  | {
      readonly success: false;
      readonly error: string;
      readonly recoverable: boolean;
    };

export interface AgentStep {
  readonly id: string;
  readonly timestamp: number;
  readonly action: AgentAction;
  readonly result: ActionResult;
  readonly screenshot?: string;
}

export type SubgoalStatus = "pending" | "in_progress" | "done" | "failed";

export interface Subgoal {
  readonly text: string;
  readonly status: SubgoalStatus;
}

export interface ActionVerdict {
  readonly worked: boolean;
  readonly note: string;
}

export interface CollectedBucketSummary {
  readonly name: string;
  readonly count: number;
  readonly sample: ReadonlyArray<unknown>;
  readonly fields: ReadonlyArray<string>;
}

export interface AgentContext {
  readonly goal: string;
  readonly history: ReadonlyArray<AgentStep>;
  readonly currentUrl: string | null;
  readonly pageText: string | null;
  readonly screenshot: string | null;
  readonly profile?: AgentTaskProfile;
  readonly loopMode?: boolean;
  readonly stepBudget?: number;
  readonly elapsedMs?: number;
  readonly remainingMs?: number;
  readonly interactiveElements?: string | null;
  readonly tabs?: ReadonlyArray<TabInfo>;
  // Self-tracking state. All optional — the agent maintains these via JSON
  // fields on its turn output and the runner echoes them back every step.
  readonly acceptanceCriteria?: string;
  readonly subgoals?: ReadonlyArray<Subgoal>;
  readonly progressNote?: string;
  readonly lastVerdict?: ActionVerdict | null;
  readonly collectedSummary?: ReadonlyArray<CollectedBucketSummary>;
  readonly repeatedActionCount?: number;
  readonly repeatedActionSignature?: string;
  readonly stepNumber?: number;
}

export interface PromptAttachment {
  readonly type: "url" | "file";
  readonly name: string;
  readonly content?: string;
  readonly url?: string;
  readonly mimeType?: string;
}

export interface AgentConfig {
  readonly maxSteps: number;
  readonly model: string;
  readonly temperature: number;
  readonly strategy: "single-tab" | "multi-tab";
  readonly maxDurationMs?: number;
  readonly loopMode?: boolean;
  readonly taskProfile?: AgentTaskProfile;
  readonly targetPaceMs?: number;
  readonly alwaysAllowScripts?: boolean;
}

export interface ConversationTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AgentSessionRequest {
  readonly goal: string;
  readonly context?: {
    readonly pageUrl: string | null;
    readonly pageText: string | null;
  };
  readonly mode: "single-tab" | "multi-tab";
  readonly attachments?: ReadonlyArray<PromptAttachment>;
  readonly conversationHistory?: ReadonlyArray<ConversationTurn>;
}

export interface AgentSession {
  readonly id: string;
  readonly goal: string;
  status: "running" | "paused" | "completed" | "error";
  steps: AgentStep[];
  currentStep: number;
  readonly maxSteps: number;
  readonly createdAt: number;
  updatedAt: number;
}

export interface TabStrategy {
  readonly name: string;
  getActiveContext(
    goal: string,
    history: ReadonlyArray<AgentStep>,
  ): Promise<AgentContext>;
  executeAction(action: AgentAction): Promise<ActionResult>;
  captureScreenshot(maxWidth?: number): Promise<string | null>;
  getPageText(): Promise<string | null>;
  getCurrentUrl(): Promise<string | null>;
  // Optional: resolve the visible label / nearby text of the action's target
  // element. Used by the HITL approval gate to detect destructive buttons.
  // Return null when the label cannot be determined (e.g. coord-only clicks
  // on CSP'd pages); callers fall back to keyword scanning of the action.
  getActionLabel?(action: AgentAction): Promise<string | null>;
}

export interface AgentStreamUpdate {
  readonly step: number;
  readonly totalSteps: number;
  readonly action: AgentAction;
  readonly status: "pending" | "running" | "success" | "error";
  readonly result?: ActionResult;
  readonly screenshot?: string;
  readonly sessionId: string;
  // Optional self-tracking fields, surfaced to the UI for progress display.
  readonly subgoal?: string;
  readonly progress?: string;
  readonly verifyLast?: ActionVerdict;
  readonly subgoals?: ReadonlyArray<Subgoal>;
  readonly acceptanceCriteria?: string;
}
