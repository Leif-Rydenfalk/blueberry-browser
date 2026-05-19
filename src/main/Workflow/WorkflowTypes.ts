export type WorkflowStepType =
  | "navigation"
  | "annotation"
  | "screenshot"
  | "interaction";

export type InteractionEventType =
  | "click"
  | "input"
  | "change"
  | "submit"
  | "keydown";

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

export interface WorkflowInteractionData {
  readonly eventType: InteractionEventType;
  readonly tag: string;
  readonly selector: string;
  readonly xpath: string;
  readonly label: string;
  readonly role?: string;
  readonly value?: string;
  readonly key?: string;
  readonly x?: number;
  readonly y?: number;
  readonly frame?: string;
  // Bind this step to a dataset column. At replay the runner substitutes
  // row[column] for the literal value above.
  readonly parameter?: { readonly column: string };
}

export interface WorkflowDataset {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<Readonly<Record<string, string>>>;
  readonly source?: string;
}

export type WorkflowStepData =
  | { readonly type: "navigation"; readonly payload: WorkflowNavigationData }
  | { readonly type: "annotation"; readonly payload: WorkflowAnnotationData }
  | { readonly type: "screenshot"; readonly payload: WorkflowScreenshotData }
  | {
      readonly type: "interaction";
      readonly payload: WorkflowInteractionData;
    };

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
  readonly dataset?: WorkflowDataset;
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
  readonly datasetRowCount?: number;
  readonly datasetColumns?: ReadonlyArray<string>;
}

export interface BulkRunProgress {
  readonly workflowId: string;
  readonly runId: string;
  readonly rowIndex: number;
  readonly totalRows: number;
  readonly status: "running" | "completed" | "error";
  readonly currentRow: Readonly<Record<string, string>>;
  readonly answer?: string;
  readonly error?: string;
}

export interface BulkRunResult {
  readonly workflowId: string;
  readonly runId: string;
  readonly totalRows: number;
  readonly successes: number;
  readonly failures: number;
  readonly csvPath: string;
}

export const WORKFLOW_CHANNELS = {
  START_RECORDING: "workflow:start-recording",
  STOP_RECORDING: "workflow:stop-recording",
  CANCEL_RECORDING: "workflow:cancel-recording",
  ADD_ANNOTATION: "workflow:add-annotation",
  GET_RECORDING_STATE: "workflow:get-recording-state",
  GET_ALL: "workflow:get-all",
  GET_ONE: "workflow:get-one",
  DELETE: "workflow:delete",
  EXECUTE: "workflow:execute",
  RENAME: "workflow:rename",
  RECORDING_UPDATE: "workflow:recording-update",
  STEP_CAPTURED: "workflow:step-captured",
  DOM_EVENT: "workflow:dom-event",
  RECORDING_ACTIVE_CHANGED: "workflow:recording-active-changed",
  SET_DATASET: "workflow:set-dataset",
  CLEAR_DATASET: "workflow:clear-dataset",
  SET_RECORDING_DATASET: "workflow:set-recording-dataset",
  BIND_STEP_TO_COLUMN: "workflow:bind-step-to-column",
  EXECUTE_BULK: "workflow:execute-bulk",
  BULK_RUN_PROGRESS: "workflow:bulk-run-progress",
  BULK_RUN_COMPLETE: "workflow:bulk-run-complete",
  ABORT_BULK: "workflow:abort-bulk",
} as const;

export interface DomEventPayload {
  readonly eventType: InteractionEventType;
  readonly tag: string;
  readonly selector: string;
  readonly xpath: string;
  readonly label: string;
  readonly role?: string;
  readonly value?: string;
  readonly key?: string;
  readonly x?: number;
  readonly y?: number;
  readonly url: string;
  readonly pageTitle: string;
  readonly timestamp: number;
}
