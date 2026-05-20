import { app, BrowserWindow } from "electron";
import { electronApp } from "@electron-toolkit/utils";
import { Window } from "./Window";
import { AppMenu } from "./Menu";
import { EventManager } from "./EventManager";
import { isTestMode, runTestMode } from "./TestHarness";

let mainWindow: Window | null = null;
let eventManager: EventManager | null = null;
let menu: AppMenu | null = null;

// WhatsApp Web and a few other apps refuse to load when the UA contains
// "Electron/..." or an unknown product name. Strip both tokens so we present
// as plain Chrome — same approach Strawberry and other Electron-based
// browsers use.
const sanitizeUserAgent = (ua: string): string => {
  const appName = app.getName();
  const escapedName = appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return ua
    .replace(/\sElectron\/\S+/g, "")
    .replace(new RegExp(`\\s${escapedName}\\/\\S+`, "gi"), "")
    .replace(/\s+/g, " ")
    .trim();
};

const createWindow = (): Window => {
  const window = new Window();
  menu = new AppMenu(window);
  eventManager = new EventManager(window);
  // Hook future tabs into the workflow recorder
  window.setOnTabCreated((tab) => {
    eventManager!.getWorkflowHandler().hookNewTab(tab);
  });
  return window;
};

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.electron");
  app.userAgentFallback = sanitizeUserAgent(app.userAgentFallback);

  mainWindow = createWindow();

  if (isTestMode()) {
    runTestMode(mainWindow).catch((err) => {
      console.error("[TestHarness] Fatal error:", err);
      app.exit(1);
    });
    return;
  }

  app.on("activate", () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (eventManager) {
    eventManager.cleanup();
    eventManager = null;
  }

  // Clean up references
  if (mainWindow) {
    mainWindow = null;
  }
  if (menu) {
    menu = null;
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});
