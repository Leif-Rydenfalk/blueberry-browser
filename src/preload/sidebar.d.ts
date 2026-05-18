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

interface ModelOption {
  readonly provider: 'openai' | 'anthropic';
  readonly model: string;
  readonly label: string;
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
  getMessages: () => Promise<any[]>;
  getModelOptions: () => Promise<ModelOption[]>;
  getModelSelection: () => Promise<ModelSelection>;
  setModelSelection: (selection: Pick<ModelSelection, "provider" | "model">) => Promise<ModelSelection>;
  onChatResponse: (callback: (data: ChatResponse) => void) => void;
  removeChatResponseListener: () => void;
  onMessagesUpdated: (callback: (messages: any[]) => void) => void;
  removeMessagesUpdatedListener: () => void;
  getPageContent: () => Promise<string | null>;
  getPageText: () => Promise<string | null>;
  getCurrentUrl: () => Promise<string | null>;
  getActiveTabInfo: () => Promise<TabInfo | null>;
  startAgentSession: (request: AgentSessionRequest) => Promise<{ sessionId: string; status: string }>;
  abortAgentSession: () => Promise<boolean>;
  sendMessageToAgent: (message: string) => Promise<boolean>;
  getAgentStatus: () => Promise<{ isRunning: boolean; activeSession: string | null }>;
  onAgentUpdate: (callback: (data: AgentStreamUpdate) => void) => void;
  removeAgentUpdateListener: () => void;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    sidebarAPI: SidebarAPI;
  }
}

export { };
