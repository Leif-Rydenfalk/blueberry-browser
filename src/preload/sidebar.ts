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
  readonly mode: 'single-tab' | 'multi-tab';
}

interface AgentStreamUpdate {
  readonly step: number;
  readonly totalSteps: number;
  readonly action: {
    readonly type: string;
    readonly params: Record<string, unknown>;
    readonly reasoning: string;
  };
  readonly status: 'pending' | 'running' | 'success' | 'error';
  readonly result?: {
    readonly success: boolean;
    readonly data?: unknown;
    readonly error?: string;
  };
  readonly screenshot?: string;
  readonly sessionId: string;
}

// Sidebar specific APIs
const sidebarAPI = {
  // Chat functionality
  sendChatMessage: (request: Partial<ChatRequest>) =>
    electronAPI.ipcRenderer.invoke("sidebar-chat-message", request),

  clearChat: () => electronAPI.ipcRenderer.invoke("sidebar-clear-chat"),
  getMessages: () => electronAPI.ipcRenderer.invoke("sidebar-get-messages"),

  onChatResponse: (callback: (data: ChatResponse) => void) => {
    electronAPI.ipcRenderer.on("chat-response", (_, data) => callback(data));
  },

  onMessagesUpdated: (callback: (messages: any[]) => void) => {
    electronAPI.ipcRenderer.on("chat-messages-updated", (_, messages) =>
      callback(messages)
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

  getAgentStatus: () =>
    electronAPI.ipcRenderer.invoke("agent:get-status"),

  onAgentUpdate: (callback: (data: AgentStreamUpdate) => void) => {
    electronAPI.ipcRenderer.on("agent:stream-update", (_, data) => callback(data));
  },

  removeAgentUpdateListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("agent:stream-update");
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
  // @ts-ignore
  window.electron = electronAPI;
  // @ts-ignore
  window.sidebarAPI = sidebarAPI;
}
