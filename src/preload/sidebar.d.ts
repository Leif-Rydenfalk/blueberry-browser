import { ElectronAPI } from "@electron-toolkit/preload";

interface ChatRequest {
  message: string;
  context: {
    url: string | null;
    content: string | null;
    text: string | null;
  };
  messageId: string;
}

interface ChatResponse {
  messageId: string;
  content: string;
  isComplete: boolean;
}

interface AgentSessionRequest {
  readonly goal: string;
  readonly context?: {
    readonly pageUrl: string | null;
    readonly pageText: string | null;
  };
  readonly mode: "single-tab" | "multi-tab";
}

interface AgentStreamUpdate {
  readonly step: number;
  readonly totalSteps: number;
  readonly action: {
    readonly type: string;
    readonly params: Record<string, unknown>;
    readonly reasoning: string;
  };
  readonly status: "pending" | "running" | "success" | "error";
  readonly result?: {
    readonly success: boolean;
    readonly data?: unknown;
    readonly error?: string;
  };
  readonly screenshot?: string;
  readonly sessionId: string;
}

interface ModelOption {
  readonly provider: "openai" | "anthropic";
  readonly model: string;
  readonly label: string;
}

interface RecordingState {
  readonly isRecording: boolean;
  readonly startedAt: number | null;
  readonly stepCount: number;
  readonly currentUrl: string | null;
}

interface WorkflowStep {
  readonly id: string;
  readonly timestamp: number;
  readonly url: string;
  readonly pageTitle: string;
  readonly data: {
    readonly type: string;
    readonly payload: Record<string, unknown>;
  };
}

interface WorkflowFull {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: number;
  readonly duration: number;
  readonly steps: ReadonlyArray<WorkflowStep>;
  readonly startUrl: string;
  readonly endUrl: string;
  readonly stepCount: number;
  readonly dataset?: WorkflowDataset;
}

interface WorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: number;
  readonly duration: number;
  readonly stepCount: number;
  readonly startUrl: string;
  readonly endUrl: string;
  readonly datasetRowCount?: number;
  readonly datasetColumns?: ReadonlyArray<string>;
}

interface WorkflowDataset {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<Record<string, string>>;
  readonly source?: string;
}

interface BulkRunProgress {
  readonly workflowId: string;
  readonly runId: string;
  readonly rowIndex: number;
  readonly totalRows: number;
  readonly status: "running" | "completed" | "error";
  readonly currentRow: Record<string, string>;
  readonly answer?: string;
  readonly error?: string;
}

interface BulkRunResult {
  readonly workflowId: string;
  readonly runId: string;
  readonly totalRows: number;
  readonly successes: number;
  readonly failures: number;
  readonly csvPath: string;
}

interface ModelSelection extends ModelOption {
  readonly configured: boolean;
}

interface TokenUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

interface TabInfo {
  id: string;
  title: string;
  url: string;
  isActive: boolean;
}

interface SidebarAPI {
  sendChatMessage: (request: Partial<ChatRequest>) => Promise<void>;
  clearChat: () => Promise<void>;
  getMessages: () => Promise<unknown[]>;
  getModelOptions: () => Promise<ModelOption[]>;
  getModelSelection: () => Promise<ModelSelection>;
  setModelSelection: (
    selection: Pick<ModelSelection, "provider" | "model">,
  ) => Promise<ModelSelection>;
  onChatResponse: (callback: (data: ChatResponse) => void) => void;
  removeChatResponseListener: () => void;
  onMessagesUpdated: (callback: (messages: unknown[]) => void) => void;
  removeMessagesUpdatedListener: () => void;
  getPageContent: () => Promise<string | null>;
  getPageText: () => Promise<string | null>;
  getCurrentUrl: () => Promise<string | null>;
  getActiveTabInfo: () => Promise<TabInfo | null>;
  startAgentSession: (
    request: AgentSessionRequest,
  ) => Promise<{ sessionId: string; status: string }>;
  abortAgentSession: () => Promise<boolean>;
  sendMessageToAgent: (message: string) => Promise<boolean>;
  getAgentStatus: () => Promise<{
    isRunning: boolean;
    activeSession: string | null;
  }>;
  onAgentUpdate: (callback: (data: AgentStreamUpdate) => void) => void;
  removeAgentUpdateListener: () => void;
  // Workflow
  startWorkflowRecording: () => Promise<RecordingState>;
  stopWorkflowRecording: (name: string) => Promise<WorkflowSummary | null>;
  cancelWorkflowRecording: () => Promise<void>;
  addWorkflowAnnotation: (text: string) => Promise<boolean>;
  getWorkflowRecordingState: () => Promise<RecordingState>;
  getAllWorkflows: () => Promise<WorkflowSummary[]>;
  getWorkflow: (id: string) => Promise<WorkflowFull | null>;
  deleteWorkflow: (id: string) => Promise<boolean>;
  renameWorkflow: (id: string, name: string) => Promise<boolean>;
  executeWorkflow: (
    id: string,
    goalOverride?: string,
  ) => Promise<{ sessionId: string; status: string } | { error: string }>;
  onWorkflowRecordingUpdate: (
    callback: (state: RecordingState) => void,
  ) => void;
  removeWorkflowRecordingUpdateListener: () => void;
  onWorkflowStepCaptured: (callback: (step: WorkflowStep) => void) => void;
  removeWorkflowStepCapturedListener: () => void;
  setWorkflowDataset: (
    id: string,
    dataset: WorkflowDataset,
  ) => Promise<boolean>;
  clearWorkflowDataset: (id: string) => Promise<boolean>;
  setRecordingDataset: (dataset: WorkflowDataset | null) => Promise<boolean>;
  bindStepToColumn: (
    id: string,
    stepId: string,
    column: string | null,
  ) => Promise<boolean>;
  executeBulkWorkflow: (
    id: string,
    goalOverride?: string,
  ) => Promise<{ runId: string } | { error: string }>;
  abortBulkWorkflow: () => Promise<boolean>;
  onBulkRunProgress: (callback: (progress: BulkRunProgress) => void) => void;
  removeBulkRunProgressListener: () => void;
  onBulkRunComplete: (callback: (result: BulkRunResult) => void) => void;
  removeBulkRunCompleteListener: () => void;
  getTokenUsage: () => Promise<TokenUsageTotals | null>;
  onTokenUsageUpdated: (callback: (totals: TokenUsageTotals) => void) => void;
  removeTokenUsageUpdatedListener: () => void;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    sidebarAPI: SidebarAPI;
  }
}

export {};
