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

interface PromptAttachment {
  readonly type: "url" | "file";
  readonly name: string;
  readonly content?: string;
  readonly url?: string;
  readonly mimeType?: string;
}

interface ConversationTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

interface AgentSessionRequest {
  readonly goal: string;
  readonly context?: {
    readonly pageUrl: string | null;
    readonly pageText: string | null;
  };
  readonly mode: "single-tab" | "multi-tab";
  readonly attachments?: PromptAttachment[];
  readonly conversationHistory?: ConversationTurn[];
}

interface AgentPreferences {
  readonly alwaysAllowScripts: boolean;
  readonly autoApprove: boolean;
}

interface AgentSubgoal {
  readonly text: string;
  readonly status: "pending" | "in_progress" | "done" | "failed";
}

interface AgentActionVerdict {
  readonly worked: boolean;
  readonly note: string;
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
  readonly subgoal?: string;
  readonly progress?: string;
  readonly verifyLast?: AgentActionVerdict;
  readonly subgoals?: ReadonlyArray<AgentSubgoal>;
  readonly acceptanceCriteria?: string;
}

type ApprovalDecision = "approve-once" | "approve-all" | "skip" | "stop";

interface ScriptReviewRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly script: string;
  readonly description: string;
  readonly name?: string;
  readonly screenshot?: string;
  readonly createdAt: number;
}

interface ApprovalRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly action: {
    readonly type: string;
    readonly params: Record<string, unknown>;
    readonly reasoning: string;
  };
  readonly reason: string;
  readonly matchedKeyword?: string;
  readonly elementLabel?: string;
  readonly previewData?: Record<string, unknown>;
  readonly screenshot?: string;
  readonly createdAt: number;
}

interface ModelOption {
  readonly provider: "openai" | "anthropic" | "google";
  readonly model: string;
  readonly label: string;
}

type ApiKeyProvider = "openai" | "anthropic" | "google";

interface ApiKeyStatus {
  readonly provider: ApiKeyProvider;
  readonly configured: boolean;
  readonly source: "ui" | "env" | "none";
  readonly preview: string | null;
  readonly updatedAt: number | null;
}

interface ApiKeyTestResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly modelCount?: number;
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
  resolveAgentApproval: (
    id: string,
    decision: ApprovalDecision,
  ) => Promise<boolean>;
  getPendingAgentApproval: () => Promise<ApprovalRequest | null>;
  onAgentApprovalRequired: (
    callback: (request: ApprovalRequest) => void,
  ) => void;
  removeAgentApprovalRequiredListener: () => void;
  getPendingAgentScriptReview: () => Promise<ScriptReviewRequest | null>;
  resolveAgentScriptReview: (
    id: string,
    decision: "approve" | "reject",
    approvedScript?: string,
  ) => Promise<boolean>;
  onAgentScriptReviewRequired: (
    callback: (request: ScriptReviewRequest) => void,
  ) => void;
  removeAgentScriptReviewRequiredListener: () => void;
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
  setSidebarWidth: (width: number) => Promise<number>;
  getSidebarWidth: () => Promise<number>;
  // MCP delegation endpoint
  getMcpStatus: () => Promise<McpStatus>;
  onMcpStatusChanged: (callback: (status: McpStatus) => void) => void;
  onMcpRequestReceived: (callback: (event: McpRequestEvent) => void) => void;
  onMcpRequestCompleted: (
    callback: (event: McpCompletionEvent) => void,
  ) => void;
  removeMcpListeners: () => void;
  // API key settings
  getApiKeyStatuses: () => Promise<ReadonlyArray<ApiKeyStatus>>;
  setApiKey: (
    provider: ApiKeyProvider,
    key: string,
  ) => Promise<ReadonlyArray<ApiKeyStatus>>;
  clearApiKey: (
    provider: ApiKeyProvider,
  ) => Promise<ReadonlyArray<ApiKeyStatus>>;
  testApiKey: (
    provider: ApiKeyProvider,
    key: string,
  ) => Promise<ApiKeyTestResult>;
  // Agent preferences
  getAgentPreferences: () => Promise<AgentPreferences>;
  setAgentPreferences: (
    prefs: Partial<AgentPreferences>,
  ) => Promise<AgentPreferences>;
}

interface McpStatus {
  readonly enabled: boolean;
  readonly listening: boolean;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly totalRequests: number;
  readonly lastError: string | null;
}

interface McpRequestEvent {
  readonly id: string;
  readonly receivedAt: number;
  readonly task: string;
  readonly clientInfo?: { readonly name?: string; readonly version?: string };
}

interface McpCompletionEvent {
  readonly id: string;
  readonly completedAt: number;
  readonly status: "completed" | "error" | "aborted";
  readonly answer: string | null;
  readonly stepCount: number;
  readonly error?: string;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    sidebarAPI: SidebarAPI;
  }
}

export {};
