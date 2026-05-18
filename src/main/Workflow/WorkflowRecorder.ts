import { v4 as uuidv4 } from 'uuid';
import type { Tab } from '../Tab';
import type { Window } from '../Window';
import type {
  Workflow,
  WorkflowStep,
  RecordingState,
} from './WorkflowTypes';

export class WorkflowRecorder {
  private recording = false;
  private startedAt: number | null = null;
  private steps: WorkflowStep[] = [];
  private lastUrl: string | null = null;
  private onUpdate: ((state: RecordingState) => void) | null = null;
  private onStepCaptured: ((step: WorkflowStep) => void) | null = null;

  // Bound listener references so we can remove them
  private readonly navListeners: Map<string, (event: Electron.Event, url: string) => void> = new Map();

  setOnUpdate(cb: (state: RecordingState) => void): void {
    this.onUpdate = cb;
  }

  setOnStepCaptured(cb: (step: WorkflowStep) => void): void {
    this.onStepCaptured = cb;
  }

  start(): void {
    if (this.recording) return;
    this.recording = true;
    this.startedAt = Date.now();
    this.steps = [];
    this.lastUrl = null;
    this.emitState();
  }

  stop(name: string): Workflow | null {
    if (!this.recording || this.steps.length === 0) {
      this.recording = false;
      this.startedAt = null;
      this.steps = [];
      return null;
    }

    const firstStep = this.steps[0];
    const lastStep = this.steps[this.steps.length - 1];
    const workflow: Workflow = {
      id: uuidv4(),
      name,
      createdAt: this.startedAt!,
      duration: Date.now() - this.startedAt!,
      steps: [...this.steps],
      startUrl: firstStep.url,
      endUrl: lastStep.url,
      stepCount: this.steps.length,
    };

    this.recording = false;
    this.startedAt = null;
    this.steps = [];
    this.lastUrl = null;
    this.emitState();

    return workflow;
  }

  cancel(): void {
    this.recording = false;
    this.startedAt = null;
    this.steps = [];
    this.lastUrl = null;
    this.emitState();
  }

  addAnnotation(text: string, currentUrl: string, pageTitle: string): void {
    if (!this.recording) return;
    const step: WorkflowStep = {
      id: uuidv4(),
      timestamp: Date.now(),
      url: currentUrl,
      pageTitle,
      data: { type: 'annotation', payload: { text } },
    };
    this.steps.push(step);
    this.onStepCaptured?.(step);
    this.emitState();
  }

  captureNavigation(tab: Tab, toUrl: string): void {
    if (!this.recording) return;
    // Deduplicate rapid same-URL events
    if (toUrl === this.lastUrl) return;
    this.lastUrl = toUrl;

    const step: WorkflowStep = {
      id: uuidv4(),
      timestamp: Date.now(),
      url: toUrl,
      pageTitle: tab.title,
      data: {
        type: 'navigation',
        payload: { fromUrl: this.lastUrl, toUrl, pageTitle: tab.title },
      },
    };
    this.steps.push(step);
    this.onStepCaptured?.(step);
    this.emitState();

    // Capture screenshot async without blocking navigation
    tab.screenshot().then(image => {
      const screenshotStep: WorkflowStep = {
        id: uuidv4(),
        timestamp: Date.now(),
        url: toUrl,
        pageTitle: tab.title,
        data: {
          type: 'screenshot',
          payload: { imageData: image.toDataURL() },
        },
      };
      this.steps.push(screenshotStep);
      this.onStepCaptured?.(screenshotStep);
    }).catch(err => {
      console.error('[WorkflowRecorder] Screenshot failed:', err);
    });
  }

  hookTab(tab: Tab): void {
    const listener = (_event: Electron.Event, url: string) => {
      this.captureNavigation(tab, url);
    };
    this.navListeners.set(tab.id, listener);
    tab.webContents.on('did-navigate', listener);
    tab.webContents.on('did-navigate-in-page', listener);
  }

  unhookTab(tab: Tab): void {
    const listener = this.navListeners.get(tab.id);
    if (!listener) return;
    tab.webContents.removeListener('did-navigate', listener);
    tab.webContents.removeListener('did-navigate-in-page', listener);
    this.navListeners.delete(tab.id);
  }

  hookAllTabs(window: Window): void {
    for (const tab of window.allTabs) {
      this.hookTab(tab);
    }
  }

  getState(): RecordingState {
    return {
      isRecording: this.recording,
      startedAt: this.startedAt,
      stepCount: this.steps.length,
      currentUrl: this.lastUrl,
    };
  }

  get isRecording(): boolean {
    return this.recording;
  }

  private emitState(): void {
    this.onUpdate?.(this.getState());
  }
}
