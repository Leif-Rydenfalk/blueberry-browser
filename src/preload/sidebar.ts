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

  // HITL approval gate
  resolveAgentApproval: (
    id: string,
    decision: "approve-once" | "approve-all" | "skip" | "stop",
  ) => electronAPI.ipcRenderer.invoke("agent:resolve-approval", id, decision),

  getPendingAgentApproval: () =>
    electronAPI.ipcRenderer.invoke("agent:get-pending-approval"),

  onAgentApprovalRequired: (
    callback: (request: {
      id: string;
      sessionId: string;
      action: {
        type: string;
        params: Record<string, unknown>;
        reasoning: string;
      };
      reason: string;
      matchedKeyword?: string;
      elementLabel?: string;
      previewData?: Record<string, unknown>;
      screenshot?: string;
      createdAt: number;
    }) => void,
  ) => {
    electronAPI.ipcRenderer.on("agent:approval-required", (_, payload) =>
      callback(payload),
    );
  },

  removeAgentApprovalRequiredListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("agent:approval-required");
  },

  // Script review gate
  getPendingAgentScriptReview: () =>
    electronAPI.ipcRenderer.invoke("agent:get-pending-script-review"),

  resolveAgentScriptReview: (
    id: string,
    decision: "approve" | "reject",
    approvedScript?: string,
  ) =>
    electronAPI.ipcRenderer.invoke("agent:resolve-script-review", id, {
      decision,
      approvedScript,
    }),

  onAgentScriptReviewRequired: (
    callback: (request: {
      id: string;
      sessionId: string;
      script: string;
      description: string;
      name?: string;
      screenshot?: string;
      createdAt: number;
    }) => void,
  ) => {
    electronAPI.ipcRenderer.on("agent:script-review-required", (_, payload) =>
      callback(payload),
    );
  },

  removeAgentScriptReviewRequiredListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("agent:script-review-required");
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

  setWorkflowDataset: (
    id: string,
    dataset: {
      columns: string[];
      rows: Record<string, string>[];
      source?: string;
    },
  ) => electronAPI.ipcRenderer.invoke("workflow:set-dataset", id, dataset),

  clearWorkflowDataset: (id: string) =>
    electronAPI.ipcRenderer.invoke("workflow:clear-dataset", id),

  setRecordingDataset: (
    dataset: {
      columns: string[];
      rows: Record<string, string>[];
      source?: string;
    } | null,
  ) =>
    electronAPI.ipcRenderer.invoke("workflow:set-recording-dataset", dataset),

  bindStepToColumn: (id: string, stepId: string, column: string | null) =>
    electronAPI.ipcRenderer.invoke(
      "workflow:bind-step-to-column",
      id,
      stepId,
      column,
    ),

  executeBulkWorkflow: (id: string, goalOverride?: string) =>
    electronAPI.ipcRenderer.invoke("workflow:execute-bulk", id, goalOverride),

  abortBulkWorkflow: () =>
    electronAPI.ipcRenderer.invoke("workflow:abort-bulk"),

  onBulkRunProgress: (
    callback: (progress: {
      workflowId: string;
      runId: string;
      rowIndex: number;
      totalRows: number;
      status: "running" | "completed" | "error";
      currentRow: Record<string, string>;
      answer?: string;
      error?: string;
    }) => void,
  ) => {
    electronAPI.ipcRenderer.on("workflow:bulk-run-progress", (_, payload) =>
      callback(payload),
    );
  },

  removeBulkRunProgressListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("workflow:bulk-run-progress");
  },

  onBulkRunComplete: (
    callback: (result: {
      workflowId: string;
      runId: string;
      totalRows: number;
      successes: number;
      failures: number;
      csvPath: string;
    }) => void,
  ) => {
    electronAPI.ipcRenderer.on("workflow:bulk-run-complete", (_, payload) =>
      callback(payload),
    );
  },

  removeBulkRunCompleteListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("workflow:bulk-run-complete");
  },

  getTokenUsage: () =>
    electronAPI.ipcRenderer.invoke("sidebar-get-token-usage"),

  setSidebarWidth: (width: number): Promise<number> =>
    electronAPI.ipcRenderer.invoke("sidebar:set-width", width),

  getSidebarWidth: (): Promise<number> =>
    electronAPI.ipcRenderer.invoke("sidebar:get-width"),

  // MCP delegation endpoint
  getMcpStatus: () => electronAPI.ipcRenderer.invoke("mcp:get-status"),

  onMcpStatusChanged: (
    callback: (status: {
      enabled: boolean;
      listening: boolean;
      host: string;
      port: number;
      url: string;
      totalRequests: number;
      lastError: string | null;
    }) => void,
  ) => {
    electronAPI.ipcRenderer.on("mcp:status-changed", (_, status) =>
      callback(status),
    );
  },

  onMcpRequestReceived: (
    callback: (event: {
      id: string;
      receivedAt: number;
      task: string;
      clientInfo?: { name?: string; version?: string };
    }) => void,
  ) => {
    electronAPI.ipcRenderer.on("mcp:request-received", (_, event) =>
      callback(event),
    );
  },

  onMcpRequestCompleted: (
    callback: (event: {
      id: string;
      completedAt: number;
      status: "completed" | "error" | "aborted";
      answer: string | null;
      stepCount: number;
      error?: string;
    }) => void,
  ) => {
    electronAPI.ipcRenderer.on("mcp:request-completed", (_, event) =>
      callback(event),
    );
  },

  removeMcpListeners: () => {
    electronAPI.ipcRenderer.removeAllListeners("mcp:status-changed");
    electronAPI.ipcRenderer.removeAllListeners("mcp:request-received");
    electronAPI.ipcRenderer.removeAllListeners("mcp:request-completed");
  },

  onTokenUsageUpdated: (
    callback: (totals: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }) => void,
  ) => {
    electronAPI.ipcRenderer.on("token-usage-updated", (_, totals) =>
      callback(totals),
    );
  },

  removeTokenUsageUpdatedListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("token-usage-updated");
  },

  // API key settings (persisted via Electron safeStorage when available)
  getApiKeyStatuses: () =>
    electronAPI.ipcRenderer.invoke("settings:get-api-key-status"),

  setApiKey: (provider: "openai" | "anthropic" | "google", key: string) =>
    electronAPI.ipcRenderer.invoke("settings:set-api-key", provider, key),

  clearApiKey: (provider: "openai" | "anthropic" | "google") =>
    electronAPI.ipcRenderer.invoke("settings:clear-api-key", provider),

  testApiKey: (provider: "openai" | "anthropic" | "google", key: string) =>
    electronAPI.ipcRenderer.invoke("settings:test-api-key", provider, key),

  // Agent behaviour preferences
  getAgentPreferences: (): Promise<AgentPreferences> =>
    electronAPI.ipcRenderer.invoke("settings:get-agent-preferences"),

  setAgentPreferences: (
    prefs: Partial<AgentPreferences>,
  ): Promise<AgentPreferences> =>
    electronAPI.ipcRenderer.invoke("settings:set-agent-preferences", prefs),
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
