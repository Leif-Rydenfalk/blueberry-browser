export type ActionType =
  | "navigate"
  | "click"
  | "type"
  | "key"
  | "scroll"
  | "wait"
  | "extract"
  | "screenshot"
  | "finish"
  | "select"
  | "hover"
  | "back"
  | "forward"
  | "newTab"
  | "switchTab"
  | "closeTab"
  | "waitForSelector";

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
  | "research";

export type ActionParamsMap = {
  navigate: NavigateParams;
  click: ClickParams;
  type: TypeParams;
  key: KeyParams;
  scroll: ScrollParams;
  wait: WaitParams;
  extract: ExtractParams;
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
}

export interface AgentConfig {
  readonly maxSteps: number;
  readonly model: string;
  readonly temperature: number;
  readonly strategy: "single-tab" | "multi-tab";
  readonly maxDurationMs?: number; // Max total time for long tasks
  readonly loopMode?: boolean; // Allow repeating patterns
  readonly taskProfile?: AgentTaskProfile;
  readonly targetPaceMs?: number;
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
}

export interface AgentStreamUpdate {
  readonly step: number;
  readonly totalSteps: number;
  readonly action: AgentAction;
  readonly status: "pending" | "running" | "success" | "error";
  readonly result?: ActionResult;
  readonly screenshot?: string;
  readonly sessionId: string;
}

export interface AgentSessionRequest {
  readonly goal: string;
  readonly context?: {
    readonly pageUrl: string | null;
    readonly pageText: string | null;
  };
  readonly mode: "single-tab" | "multi-tab";
}
