export type WorkflowStepType = 'navigation' | 'annotation' | 'screenshot';

export interface WorkflowNavigationData {
  readonly fromUrl: string | null;
  readonly toUrl: string;
  readonly pageTitle: string;
}

export interface WorkflowAnnotationData {
  readonly text: string;
}

export interface WorkflowScreenshotData {
  readonly imageData: string;
}

export type WorkflowStepData =
  | { readonly type: 'navigation'; readonly payload: WorkflowNavigationData }
  | { readonly type: 'annotation'; readonly payload: WorkflowAnnotationData }
  | { readonly type: 'screenshot'; readonly payload: WorkflowScreenshotData };

export interface WorkflowStep {
  readonly id: string;
  readonly timestamp: number;
  readonly url: string;
  readonly pageTitle: string;
  readonly data: WorkflowStepData;
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: number;
  readonly duration: number;
  readonly steps: WorkflowStep[];
  readonly startUrl: string;
  readonly endUrl: string;
  readonly stepCount: number;
}

export interface RecordingState {
  readonly isRecording: boolean;
  readonly startedAt: number | null;
  readonly stepCount: number;
  readonly currentUrl: string | null;
}

export interface WorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: number;
  readonly duration: number;
  readonly stepCount: number;
  readonly startUrl: string;
  readonly endUrl: string;
}

export const WORKFLOW_CHANNELS = {
  START_RECORDING: 'workflow:start-recording',
  STOP_RECORDING: 'workflow:stop-recording',
  CANCEL_RECORDING: 'workflow:cancel-recording',
  ADD_ANNOTATION: 'workflow:add-annotation',
  GET_RECORDING_STATE: 'workflow:get-recording-state',
  GET_ALL: 'workflow:get-all',
  GET_ONE: 'workflow:get-one',
  DELETE: 'workflow:delete',
  EXECUTE: 'workflow:execute',
  RENAME: 'workflow:rename',
  RECORDING_UPDATE: 'workflow:recording-update',
  STEP_CAPTURED: 'workflow:step-captured',
} as const;
