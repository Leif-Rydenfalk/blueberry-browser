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

interface WorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: number;
  readonly duration: number;
  readonly stepCount: number;
  readonly startUrl: string;
  readonly endUrl: string;
}

interface ModelSelection extends ModelOption {
  readonly configured: boolean;
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
  getWorkflow: (id: string) => Promise<unknown>;
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
}

declare global {
  interface Window {
    electron: ElectronAPI;
    sidebarAPI: SidebarAPI;
  }
}

export {};
