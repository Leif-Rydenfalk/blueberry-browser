import { ipcMain, WebContents } from "electron";
import type { Window } from "./Window";
import { AgentIpcHandler } from "./Agent/core/AgentIpcHandler";
import { WorkflowIpcHandler } from "./Workflow/WorkflowIpcHandler";
import {
  WORKFLOW_CHANNELS,
  type WorkflowDataset,
} from "./Workflow/WorkflowTypes";
import { McpHandler } from "./Mcp/McpHandler";
import { McpServer, readMcpOptionsFromEnv } from "./Mcp/McpServer";
import { MCP_CHANNELS } from "./Mcp/McpTypes";
import { SettingsIpcHandler } from "./Settings/SettingsIpcHandler";
import {
  SETTINGS_CHANNELS,
  type AgentPreferences,
  type ApiKeyProvider,
} from "./Settings/SettingsTypes";

export class EventManager {
  private mainWindow: Window;
  private agentHandler: AgentIpcHandler;
  private workflowHandler: WorkflowIpcHandler;
  private mcpHandler: McpHandler;
  private mcpServer: McpServer;
  private settingsHandler: SettingsIpcHandler;

  constructor(mainWindow: Window) {
    this.mainWindow = mainWindow;
    this.agentHandler = new AgentIpcHandler(mainWindow);
    this.workflowHandler = new WorkflowIpcHandler(mainWindow);
    // The workflow handler drives bulk runs through the agent orchestrator.
    this.workflowHandler.setOrchestrator(this.agentHandler.orchestrator);

    // MCP delegation endpoint — outside agents call into our orchestrator.
    this.mcpHandler = new McpHandler(this.agentHandler.orchestrator);
    this.mcpServer = new McpServer(
      this.mcpHandler,
      readMcpOptionsFromEnv(process.env.npm_package_version ?? "1.0.0"),
    );

    // API key + last-model settings (encrypted via safeStorage).
    this.settingsHandler = new SettingsIpcHandler(
      mainWindow.sidebar.settings,
      mainWindow.sidebar.client,
    );

    this.setupEventHandlers();
    this.setupAgentHandlers();
    this.setupWorkflowHandlers();
    this.setupMcpHandlers();
    this.setupSettingsHandlers();

    // Kick off the MCP server in the background; failures are logged inside.
    void this.mcpServer.start().catch((err) => {
      console.error("[EventManager] MCP server failed to start:", err);
    });
  }

  getWorkflowHandler(): WorkflowIpcHandler {
    return this.workflowHandler;
  }

  getMcpServer(): McpServer {
    return this.mcpServer;
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

    ipcMain.handle(
      "agent:resolve-approval",
      (
        _,
        id: string,
        decision: "approve-once" | "approve-all" | "skip" | "stop",
      ) => {
        return this.agentHandler.resolveApproval(id, decision);
      },
    );

    ipcMain.handle("agent:get-pending-approval", () => {
      return this.agentHandler.getPendingApproval();
    });

    // Broadcasts agent updates to sidebar UI
    this.agentHandler.onUpdate((update) => {
      this.mainWindow.sidebar.view.webContents.send(
        "agent:stream-update",
        update,
      );
    });

    this.agentHandler.onApprovalRequired((request) => {
      this.mainWindow.sidebar.view.webContents.send(
        "agent:approval-required",
        request,
      );
    });

    this.agentHandler.onScriptReviewRequired((request) => {
      this.mainWindow.sidebar.view.webContents.send(
        "agent:script-review-required",
        request,
      );
    });

    ipcMain.handle(
      "agent:resolve-script-review",
      (_, id: string, resolution: { decision: "approve" | "reject"; approvedScript?: string }) => {
        return this.agentHandler.resolveScriptReview(id, resolution);
      },
    );

    ipcMain.handle("agent:get-pending-script-review", () => {
      return this.agentHandler.getPendingScriptReview();
    });
  }

  private setupWorkflowHandlers(): void {
    // Push recording state changes to sidebar
    this.workflowHandler.setOnUpdate((state) => {
      this.mainWindow.sidebar.view.webContents.send(
        WORKFLOW_CHANNELS.RECORDING_UPDATE,
        state,
      );
    });
    this.workflowHandler.setOnStepCaptured((step) => {
      this.mainWindow.sidebar.view.webContents.send(
        WORKFLOW_CHANNELS.STEP_CAPTURED,
        step,
      );
    });
    this.workflowHandler.setOnBulkProgress((progress) => {
      this.mainWindow.sidebar.view.webContents.send(
        WORKFLOW_CHANNELS.BULK_RUN_PROGRESS,
        progress,
      );
    });
    this.workflowHandler.setOnBulkComplete((result) => {
      this.mainWindow.sidebar.view.webContents.send(
        WORKFLOW_CHANNELS.BULK_RUN_COMPLETE,
        result,
      );
    });

    ipcMain.handle(WORKFLOW_CHANNELS.START_RECORDING, () => {
      return this.workflowHandler.startRecording();
    });

    ipcMain.handle(
      WORKFLOW_CHANNELS.STOP_RECORDING,
      async (_, name: string) => {
        return await this.workflowHandler.stopRecording(name);
      },
    );

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

    ipcMain.handle(
      WORKFLOW_CHANNELS.EXECUTE,
      async (_, id: string, goalOverride?: string) => {
        const prompt = this.workflowHandler.buildAgentPrompt(id, goalOverride);
        if (!prompt) return { error: "Workflow not found" };
        const result = await this.agentHandler.start({
          goal: prompt,
          mode: "single-tab",
        });
        return result;
      },
    );

    // Tab preloads (tabRecorder.ts) push DOM events here while recording is active.
    ipcMain.on(WORKFLOW_CHANNELS.DOM_EVENT, (_event, payload) => {
      this.workflowHandler.handleDomEvent(payload);
    });

    // Dataset operations
    ipcMain.handle(
      WORKFLOW_CHANNELS.SET_DATASET,
      (_event, id: string, dataset: WorkflowDataset) => {
        return this.workflowHandler.attachDataset(id, dataset);
      },
    );

    ipcMain.handle(WORKFLOW_CHANNELS.CLEAR_DATASET, (_event, id: string) => {
      return this.workflowHandler.clearDataset(id);
    });

    ipcMain.handle(
      WORKFLOW_CHANNELS.SET_RECORDING_DATASET,
      (_event, dataset: WorkflowDataset | null) => {
        this.workflowHandler.setRecordingDataset(dataset);
        return true;
      },
    );

    ipcMain.handle(
      WORKFLOW_CHANNELS.BIND_STEP_TO_COLUMN,
      (_event, id: string, stepId: string, column: string | null) => {
        return this.workflowHandler.bindStepToColumn(id, stepId, column);
      },
    );

    ipcMain.handle(
      WORKFLOW_CHANNELS.EXECUTE_BULK,
      async (_event, id: string, goalOverride?: string) => {
        return await this.workflowHandler.executeBulk(id, { goalOverride });
      },
    );

    ipcMain.handle(WORKFLOW_CHANNELS.ABORT_BULK, () => {
      this.workflowHandler.abortBulk();
      return true;
    });
  }

  private setupMcpHandlers(): void {
    this.mcpServer.setOnStatusChanged((status) => {
      this.mainWindow.sidebar.view.webContents.send(
        MCP_CHANNELS.STATUS_CHANGED,
        status,
      );
    });

    this.mcpHandler.setOnRequest((event) => {
      this.mainWindow.sidebar.view.webContents.send(
        MCP_CHANNELS.REQUEST_RECEIVED,
        event,
      );
    });

    this.mcpHandler.setOnCompletion((event) => {
      this.mainWindow.sidebar.view.webContents.send(
        MCP_CHANNELS.REQUEST_COMPLETED,
        event,
      );
    });

    ipcMain.handle(MCP_CHANNELS.GET_STATUS, () => {
      return this.mcpServer.getStatus();
    });
  }

  private setupSettingsHandlers(): void {
    ipcMain.handle(SETTINGS_CHANNELS.GET_API_KEY_STATUS, () => {
      return this.settingsHandler.getApiKeyStatuses();
    });

    ipcMain.handle(
      SETTINGS_CHANNELS.SET_API_KEY,
      (_event, provider: ApiKeyProvider, key: string) => {
        return this.settingsHandler.setApiKey(provider, key);
      },
    );

    ipcMain.handle(
      SETTINGS_CHANNELS.CLEAR_API_KEY,
      (_event, provider: ApiKeyProvider) => {
        return this.settingsHandler.clearApiKey(provider);
      },
    );

    ipcMain.handle(
      SETTINGS_CHANNELS.TEST_API_KEY,
      (_event, provider: ApiKeyProvider, key: string) => {
        return this.settingsHandler.testApiKey(provider, key);
      },
    );

    ipcMain.handle(SETTINGS_CHANNELS.GET_AGENT_PREFERENCES, () => {
      return this.settingsHandler.getAgentPreferences();
    });

    ipcMain.handle(
      SETTINGS_CHANNELS.SET_AGENT_PREFERENCES,
      (_event, prefs: Partial<AgentPreferences>) => {
        return this.settingsHandler.setAgentPreferences(prefs);
      },
    );
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

    ipcMain.handle("sidebar:set-width", (_, width: number) => {
      const applied = this.mainWindow.sidebar.setWidth(width);
      this.mainWindow.updateAllBounds();
      return applied;
    });

    ipcMain.handle("sidebar:get-width", () => {
      return this.mainWindow.sidebar.getWidth();
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

    ipcMain.handle(
      "sidebar-set-model-selection",
      (_, selection: { provider: "openai" | "anthropic"; model: string }) => {
        return this.mainWindow.sidebar.client.setModelSelection(
          selection.provider,
          selection.model,
        );
      },
    );

    ipcMain.handle("sidebar-get-token-usage", () => {
      return this.mainWindow.sidebar.client.getTokenUsage();
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
      this.mainWindow.topBar.view.webContents.send(
        "dark-mode-updated",
        isDarkMode,
      );
    }

    if (this.mainWindow.sidebar.view.webContents !== sender) {
      this.mainWindow.sidebar.view.webContents.send(
        "dark-mode-updated",
        isDarkMode,
      );
    }

    this.mainWindow.allTabs.forEach((tab) => {
      if (tab.webContents !== sender) {
        tab.webContents.send("dark-mode-updated", isDarkMode);
      }
    });
  }

  public cleanup(): void {
    ipcMain.removeAllListeners();
    void this.mcpServer.stop().catch((err) => {
      console.error("[EventManager] MCP server stop failed:", err);
    });
  }
}
