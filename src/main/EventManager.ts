import { ipcMain, WebContents } from "electron";
import type { Window } from "./Window";
import { AgentIpcHandler } from "./Agent/core/AgentIpcHandler";
import { WorkflowIpcHandler } from "./Workflow/WorkflowIpcHandler";
import { WORKFLOW_CHANNELS } from "./Workflow/WorkflowTypes";

export class EventManager {
  private mainWindow: Window;
  private agentHandler: AgentIpcHandler;
  private workflowHandler: WorkflowIpcHandler;

  constructor(mainWindow: Window) {
    this.mainWindow = mainWindow;
    this.agentHandler = new AgentIpcHandler(mainWindow);
    this.workflowHandler = new WorkflowIpcHandler(mainWindow);
    this.setupEventHandlers();
    this.setupAgentHandlers();
    this.setupWorkflowHandlers();
  }

  getWorkflowHandler(): WorkflowIpcHandler {
    return this.workflowHandler;
  }

  private setupEventHandlers(): void {
    this.handleTabEvents();
    this.handleSidebarEvents();
    this.handlePageContentEvents();
    this.handleDarkModeEvents();
    this.handleDebugEvents();
  }

  private setupAgentHandlers(): void {
    ipcMain.handle("agent:start-session", async (_, request) => {
      const result = await this.agentHandler.start(request);
      return result;
    });

    ipcMain.handle("agent:abort-session", () => {
      return this.agentHandler.abort();
    });

    ipcMain.handle("agent:send-message", (_, message: string) => {
      return this.agentHandler.sendMessage(message);
    });

    ipcMain.handle("agent:get-status", () => {
      return this.agentHandler.getStatus();
    });

    // Broadcasts agent updates to sidebar UI
    this.agentHandler.onUpdate((update) => {
      this.mainWindow.sidebar.view.webContents.send("agent:stream-update", update);
    });
  }

  private setupWorkflowHandlers(): void {
    // Push recording state changes to sidebar
    this.workflowHandler.setOnUpdate((state) => {
      this.mainWindow.sidebar.view.webContents.send(WORKFLOW_CHANNELS.RECORDING_UPDATE, state);
    });
    this.workflowHandler.setOnStepCaptured((step) => {
      this.mainWindow.sidebar.view.webContents.send(WORKFLOW_CHANNELS.STEP_CAPTURED, step);
    });

    ipcMain.handle(WORKFLOW_CHANNELS.START_RECORDING, () => {
      return this.workflowHandler.startRecording();
    });

    ipcMain.handle(WORKFLOW_CHANNELS.STOP_RECORDING, async (_, name: string) => {
      return await this.workflowHandler.stopRecording(name);
    });

    ipcMain.handle(WORKFLOW_CHANNELS.CANCEL_RECORDING, () => {
      this.workflowHandler.cancelRecording();
    });

    ipcMain.handle(WORKFLOW_CHANNELS.ADD_ANNOTATION, (_, text: string) => {
      return this.workflowHandler.addAnnotation(text);
    });

    ipcMain.handle(WORKFLOW_CHANNELS.GET_RECORDING_STATE, () => {
      return this.workflowHandler.getRecordingState();
    });

    ipcMain.handle(WORKFLOW_CHANNELS.GET_ALL, () => {
      return this.workflowHandler.getAllWorkflows();
    });

    ipcMain.handle(WORKFLOW_CHANNELS.GET_ONE, (_, id: string) => {
      return this.workflowHandler.getWorkflow(id);
    });

    ipcMain.handle(WORKFLOW_CHANNELS.DELETE, (_, id: string) => {
      return this.workflowHandler.deleteWorkflow(id);
    });

    ipcMain.handle(WORKFLOW_CHANNELS.RENAME, (_, id: string, name: string) => {
      return this.workflowHandler.renameWorkflow(id, name);
    });

    ipcMain.handle(WORKFLOW_CHANNELS.EXECUTE, async (_, id: string, goalOverride?: string) => {
      const prompt = this.workflowHandler.buildAgentPrompt(id, goalOverride);
      if (!prompt) return { error: 'Workflow not found' };
      const result = await this.agentHandler.start({
        goal: prompt,
        mode: 'single-tab',
      });
      return result;
    });
  }

  private handleTabEvents(): void {
    ipcMain.handle("create-tab", (_, url?: string) => {
      const newTab = this.mainWindow.createTab(url);
      return { id: newTab.id, title: newTab.title, url: newTab.url };
    });

    ipcMain.handle("close-tab", (_, id: string) => {
      this.mainWindow.closeTab(id);
    });

    ipcMain.handle("switch-tab", (_, id: string) => {
      this.mainWindow.switchActiveTab(id);
    });

    ipcMain.handle("get-tabs", () => {
      const activeTabId = this.mainWindow.activeTab?.id;
      return this.mainWindow.allTabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        isActive: activeTabId === tab.id,
      }));
    });

    ipcMain.handle("navigate-to", (_, url: string) => {
      if (this.mainWindow.activeTab) {
        this.mainWindow.activeTab.loadURL(url);
      }
    });

    ipcMain.handle("navigate-tab", async (_, tabId: string, url: string) => {
      const tab = this.mainWindow.getTab(tabId);
      if (tab) {
        await tab.loadURL(url);
        return true;
      }
      return false;
    });

    ipcMain.handle("go-back", () => {
      if (this.mainWindow.activeTab) {
        this.mainWindow.activeTab.goBack();
      }
    });

    ipcMain.handle("go-forward", () => {
      if (this.mainWindow.activeTab) {
        this.mainWindow.activeTab.goForward();
      }
    });

    ipcMain.handle("reload", () => {
      if (this.mainWindow.activeTab) {
        this.mainWindow.activeTab.reload();
      }
    });

    ipcMain.handle("tab-go-back", (_, tabId: string) => {
      const tab = this.mainWindow.getTab(tabId);
      if (tab) {
        tab.goBack();
        return true;
      }
      return false;
    });

    ipcMain.handle("tab-go-forward", (_, tabId: string) => {
      const tab = this.mainWindow.getTab(tabId);
      if (tab) {
        tab.goForward();
        return true;
      }
      return false;
    });

    ipcMain.handle("tab-reload", (_, tabId: string) => {
      const tab = this.mainWindow.getTab(tabId);
      if (tab) {
        tab.reload();
        return true;
      }
      return false;
    });

    ipcMain.handle("tab-screenshot", async (_, tabId: string) => {
      const tab = this.mainWindow.getTab(tabId);
      if (tab) {
        const image = await tab.screenshot();
        return image.toDataURL();
      }
      return null;
    });

    ipcMain.handle("tab-run-js", async (_, tabId: string, code: string) => {
      const tab = this.mainWindow.getTab(tabId);
      if (tab) {
        return await tab.runJs(code);
      }
      return null;
    });

    ipcMain.handle("get-active-tab-info", () => {
      const activeTab = this.mainWindow.activeTab;
      if (activeTab) {
        return {
          id: activeTab.id,
          url: activeTab.url,
          title: activeTab.title,
          canGoBack: activeTab.webContents.canGoBack(),
          canGoForward: activeTab.webContents.canGoForward(),
        };
      }
      return null;
    });
  }

  private handleSidebarEvents(): void {
    ipcMain.handle("toggle-sidebar", () => {
      this.mainWindow.sidebar.toggle();
      this.mainWindow.updateAllBounds();
      return true;
    });

    ipcMain.handle("sidebar-chat-message", async (_, request) => {
      await this.mainWindow.sidebar.client.sendChatMessage(request);
    });

    ipcMain.handle("sidebar-clear-chat", () => {
      this.mainWindow.sidebar.client.clearMessages();
      return true;
    });

    ipcMain.handle("sidebar-get-messages", () => {
      return this.mainWindow.sidebar.client.getMessages();
    });

    ipcMain.handle("sidebar-get-model-options", () => {
      return this.mainWindow.sidebar.client.getModelOptions();
    });

    ipcMain.handle("sidebar-get-model-selection", () => {
      return this.mainWindow.sidebar.client.getModelSelection();
    });

    ipcMain.handle("sidebar-set-model-selection", (_, selection: { provider: "openai" | "anthropic"; model: string }) => {
      return this.mainWindow.sidebar.client.setModelSelection(selection.provider, selection.model);
    });
  }

  private handlePageContentEvents(): void {
    ipcMain.handle("get-page-content", async () => {
      if (this.mainWindow.activeTab) {
        try {
          return await this.mainWindow.activeTab.getTabHtml();
        } catch (error) {
          console.error("Error getting page content:", error);
          return null;
        }
      }
      return null;
    });

    ipcMain.handle("get-page-text", async () => {
      if (this.mainWindow.activeTab) {
        try {
          return await this.mainWindow.activeTab.getTabText();
        } catch (error) {
          console.error("Error getting page text:", error);
          return null;
        }
      }
      return null;
    });

    ipcMain.handle("get-current-url", () => {
      if (this.mainWindow.activeTab) {
        return this.mainWindow.activeTab.url;
      }
      return null;
    });
  }

  private handleDarkModeEvents(): void {
    ipcMain.on("dark-mode-changed", (event, isDarkMode) => {
      this.broadcastDarkMode(event.sender, isDarkMode);
    });
  }

  private handleDebugEvents(): void {
    ipcMain.on("ping", () => console.log("pong"));
  }

  private broadcastDarkMode(sender: WebContents, isDarkMode: boolean): void {
    if (this.mainWindow.topBar.view.webContents !== sender) {
      this.mainWindow.topBar.view.webContents.send("dark-mode-updated", isDarkMode);
    }

    if (this.mainWindow.sidebar.view.webContents !== sender) {
      this.mainWindow.sidebar.view.webContents.send("dark-mode-updated", isDarkMode);
    }

    this.mainWindow.allTabs.forEach((tab) => {
      if (tab.webContents !== sender) {
        tab.webContents.send("dark-mode-updated", isDarkMode);
      }
    });
  }

  public cleanup(): void {
    ipcMain.removeAllListeners();
  }
}
