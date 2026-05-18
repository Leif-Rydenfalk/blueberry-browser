import { contextBridge } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

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

interface ModelSelection extends ModelOption {
  readonly configured: boolean;
}

// Sidebar specific APIs
const sidebarAPI = {
  // Chat functionality
  sendChatMessage: (request: Partial<ChatRequest>) =>
    electronAPI.ipcRenderer.invoke("sidebar-chat-message", request),

  clearChat: () => electronAPI.ipcRenderer.invoke("sidebar-clear-chat"),
  getMessages: () => electronAPI.ipcRenderer.invoke("sidebar-get-messages"),
  getModelOptions: () =>
    electronAPI.ipcRenderer.invoke("sidebar-get-model-options"),
  getModelSelection: () =>
    electronAPI.ipcRenderer.invoke("sidebar-get-model-selection"),
  setModelSelection: (selection: Pick<ModelSelection, "provider" | "model">) =>
    electronAPI.ipcRenderer.invoke("sidebar-set-model-selection", selection),

  onChatResponse: (callback: (data: ChatResponse) => void) => {
    electronAPI.ipcRenderer.on("chat-response", (_, data) => callback(data));
  },

  onMessagesUpdated: (callback: (messages: unknown[]) => void) => {
    electronAPI.ipcRenderer.on("chat-messages-updated", (_, messages) =>
      callback(messages),
    );
  },

  removeChatResponseListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("chat-response");
  },

  removeMessagesUpdatedListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("chat-messages-updated");
  },

  // Page content access
  getPageContent: () => electronAPI.ipcRenderer.invoke("get-page-content"),
  getPageText: () => electronAPI.ipcRenderer.invoke("get-page-text"),
  getCurrentUrl: () => electronAPI.ipcRenderer.invoke("get-current-url"),

  // Tab information
  getActiveTabInfo: () => electronAPI.ipcRenderer.invoke("get-active-tab-info"),

  // Agent functionality
  startAgentSession: (request: AgentSessionRequest) =>
    electronAPI.ipcRenderer.invoke("agent:start-session", request),

  abortAgentSession: () =>
    electronAPI.ipcRenderer.invoke("agent:abort-session"),

  sendMessageToAgent: (message: string) =>
    electronAPI.ipcRenderer.invoke("agent:send-message", message),

  getAgentStatus: () => electronAPI.ipcRenderer.invoke("agent:get-status"),

  onAgentUpdate: (callback: (data: AgentStreamUpdate) => void) => {
    electronAPI.ipcRenderer.on("agent:stream-update", (_, data) =>
      callback(data),
    );
  },

  removeAgentUpdateListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("agent:stream-update");
  },

  // Workflow functionality
  startWorkflowRecording: () =>
    electronAPI.ipcRenderer.invoke("workflow:start-recording"),

  stopWorkflowRecording: (name: string) =>
    electronAPI.ipcRenderer.invoke("workflow:stop-recording", name),

  cancelWorkflowRecording: () =>
    electronAPI.ipcRenderer.invoke("workflow:cancel-recording"),

  addWorkflowAnnotation: (text: string) =>
    electronAPI.ipcRenderer.invoke("workflow:add-annotation", text),

  getWorkflowRecordingState: () =>
    electronAPI.ipcRenderer.invoke("workflow:get-recording-state"),

  getAllWorkflows: () => electronAPI.ipcRenderer.invoke("workflow:get-all"),

  getWorkflow: (id: string) =>
    electronAPI.ipcRenderer.invoke("workflow:get-one", id),

  deleteWorkflow: (id: string) =>
    electronAPI.ipcRenderer.invoke("workflow:delete", id),

  renameWorkflow: (id: string, name: string) =>
    electronAPI.ipcRenderer.invoke("workflow:rename", id, name),

  executeWorkflow: (id: string, goalOverride?: string) =>
    electronAPI.ipcRenderer.invoke("workflow:execute", id, goalOverride),

  onWorkflowRecordingUpdate: (callback: (state: RecordingState) => void) => {
    electronAPI.ipcRenderer.on("workflow:recording-update", (_, state) =>
      callback(state),
    );
  },

  removeWorkflowRecordingUpdateListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("workflow:recording-update");
  },

  onWorkflowStepCaptured: (callback: (step: WorkflowStep) => void) => {
    electronAPI.ipcRenderer.on("workflow:step-captured", (_, step) =>
      callback(step),
    );
  },

  removeWorkflowStepCapturedListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("workflow:step-captured");
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("sidebarAPI", sidebarAPI);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore -- non-isolated context: direct window assignment required by Electron
  window.electron = electronAPI;
  // @ts-ignore -- non-isolated context: direct window assignment required by Electron
  window.sidebarAPI = sidebarAPI;
}
