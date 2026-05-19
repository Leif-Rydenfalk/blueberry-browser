import React, {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useCallback,
} from "react";

interface RecordingState {
  isRecording: boolean;
  startedAt: number | null;
  stepCount: number;
  currentUrl: string | null;
}

interface WorkflowDataset {
  columns: ReadonlyArray<string>;
  rows: ReadonlyArray<Record<string, string>>;
  source?: string;
}

interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  duration: number;
  stepCount: number;
  startUrl: string;
  endUrl: string;
  datasetRowCount?: number;
  datasetColumns?: ReadonlyArray<string>;
}

interface BulkProgress {
  workflowId: string;
  runId: string;
  rowIndex: number;
  totalRows: number;
  status: "running" | "completed" | "error";
  currentRow: Record<string, string>;
  answer?: string;
  error?: string;
}

interface BulkResult {
  workflowId: string;
  runId: string;
  totalRows: number;
  successes: number;
  failures: number;
  csvPath: string;
}

interface WorkflowContextValue {
  recording: RecordingState;
  workflows: WorkflowSummary[];
  isExecuting: boolean;
  recordingDataset: WorkflowDataset | null;
  bulkProgress: BulkProgress | null;
  bulkResult: BulkResult | null;
  startRecording: () => Promise<void>;
  stopRecording: (name: string) => Promise<void>;
  cancelRecording: () => Promise<void>;
  addAnnotation: (text: string) => Promise<void>;
  deleteWorkflow: (id: string) => Promise<void>;
  renameWorkflow: (id: string, name: string) => Promise<void>;
  executeWorkflow: (id: string, goalOverride?: string) => Promise<void>;
  executeBulkWorkflow: (id: string, goalOverride?: string) => Promise<void>;
  abortBulkWorkflow: () => Promise<void>;
  setRecordingDataset: (dataset: WorkflowDataset | null) => Promise<void>;
  attachDataset: (id: string, dataset: WorkflowDataset) => Promise<void>;
  clearDataset: (id: string) => Promise<void>;
  bindStepToColumn: (
    id: string,
    stepId: string,
    column: string | null,
  ) => Promise<void>;
  fetchWorkflow: (id: string) => Promise<unknown>;
  refreshWorkflows: () => Promise<void>;
}

interface State {
  recording: RecordingState;
  workflows: WorkflowSummary[];
  isExecuting: boolean;
  recordingDataset: WorkflowDataset | null;
  bulkProgress: BulkProgress | null;
  bulkResult: BulkResult | null;
}

type Action =
  | { type: "SET_RECORDING"; payload: RecordingState }
  | { type: "SET_WORKFLOWS"; payload: WorkflowSummary[] }
  | { type: "DELETE_WORKFLOW"; payload: string }
  | { type: "RENAME_WORKFLOW"; payload: { id: string; name: string } }
  | { type: "SET_EXECUTING"; payload: boolean }
  | { type: "SET_RECORDING_DATASET"; payload: WorkflowDataset | null }
  | { type: "SET_BULK_PROGRESS"; payload: BulkProgress | null }
  | { type: "SET_BULK_RESULT"; payload: BulkResult | null };

const initialRecording: RecordingState = {
  isRecording: false,
  startedAt: null,
  stepCount: 0,
  currentUrl: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SET_RECORDING":
      return { ...state, recording: action.payload };
    case "SET_WORKFLOWS":
      return { ...state, workflows: action.payload };
    case "DELETE_WORKFLOW":
      return {
        ...state,
        workflows: state.workflows.filter((w) => w.id !== action.payload),
      };
    case "RENAME_WORKFLOW":
      return {
        ...state,
        workflows: state.workflows.map((w) =>
          w.id === action.payload.id ? { ...w, name: action.payload.name } : w,
        ),
      };
    case "SET_EXECUTING":
      return { ...state, isExecuting: action.payload };
    case "SET_RECORDING_DATASET":
      return { ...state, recordingDataset: action.payload };
    case "SET_BULK_PROGRESS":
      return { ...state, bulkProgress: action.payload };
    case "SET_BULK_RESULT":
      return { ...state, bulkResult: action.payload };
  }
}

const WorkflowContext = createContext<WorkflowContextValue | null>(null);

export const WorkflowProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [state, dispatch] = useReducer(reducer, {
    recording: initialRecording,
    workflows: [],
    isExecuting: false,
    recordingDataset: null,
    bulkProgress: null,
    bulkResult: null,
  });

  useEffect(() => {
    window.sidebarAPI.getWorkflowRecordingState().then((s) => {
      dispatch({ type: "SET_RECORDING", payload: s });
    });
    window.sidebarAPI.getAllWorkflows().then((ws) => {
      dispatch({ type: "SET_WORKFLOWS", payload: ws });
    });

    window.sidebarAPI.onWorkflowRecordingUpdate((s) => {
      dispatch({ type: "SET_RECORDING", payload: s });
    });
    window.sidebarAPI.onBulkRunProgress((p) => {
      dispatch({ type: "SET_BULK_PROGRESS", payload: p });
    });
    window.sidebarAPI.onBulkRunComplete((r) => {
      dispatch({ type: "SET_BULK_RESULT", payload: r });
      dispatch({ type: "SET_EXECUTING", payload: false });
    });

    return () => {
      window.sidebarAPI.removeWorkflowRecordingUpdateListener();
      window.sidebarAPI.removeBulkRunProgressListener();
      window.sidebarAPI.removeBulkRunCompleteListener();
    };
  }, []);

  const startRecording = useCallback(async () => {
    const recordingState = await window.sidebarAPI.startWorkflowRecording();
    dispatch({ type: "SET_RECORDING", payload: recordingState });
  }, []);

  const stopRecording = useCallback(async (name: string) => {
    await window.sidebarAPI.stopWorkflowRecording(name);
    const ws = await window.sidebarAPI.getAllWorkflows();
    dispatch({ type: "SET_WORKFLOWS", payload: ws });
    // Clear active recording dataset — it's now persisted on the workflow.
    dispatch({ type: "SET_RECORDING_DATASET", payload: null });
    await window.sidebarAPI.setRecordingDataset(null);
  }, []);

  const cancelRecording = useCallback(async () => {
    await window.sidebarAPI.cancelWorkflowRecording();
    dispatch({ type: "SET_RECORDING_DATASET", payload: null });
    await window.sidebarAPI.setRecordingDataset(null);
  }, []);

  const addAnnotation = useCallback(async (text: string) => {
    await window.sidebarAPI.addWorkflowAnnotation(text);
  }, []);

  const deleteWorkflow = useCallback(async (id: string) => {
    await window.sidebarAPI.deleteWorkflow(id);
    dispatch({ type: "DELETE_WORKFLOW", payload: id });
  }, []);

  const renameWorkflow = useCallback(async (id: string, name: string) => {
    await window.sidebarAPI.renameWorkflow(id, name);
    dispatch({ type: "RENAME_WORKFLOW", payload: { id, name } });
  }, []);

  const executeWorkflow = useCallback(
    async (id: string, goalOverride?: string) => {
      dispatch({ type: "SET_EXECUTING", payload: true });
      try {
        await window.sidebarAPI.executeWorkflow(id, goalOverride);
      } finally {
        dispatch({ type: "SET_EXECUTING", payload: false });
      }
    },
    [],
  );

  const executeBulkWorkflow = useCallback(
    async (id: string, goalOverride?: string) => {
      dispatch({ type: "SET_EXECUTING", payload: true });
      dispatch({ type: "SET_BULK_PROGRESS", payload: null });
      dispatch({ type: "SET_BULK_RESULT", payload: null });
      await window.sidebarAPI.executeBulkWorkflow(id, goalOverride);
      // isExecuting flips back when bulk completion fires
    },
    [],
  );

  const abortBulkWorkflow = useCallback(async () => {
    await window.sidebarAPI.abortBulkWorkflow();
  }, []);

  const setRecordingDataset = useCallback(
    async (dataset: WorkflowDataset | null) => {
      await window.sidebarAPI.setRecordingDataset(dataset);
      dispatch({ type: "SET_RECORDING_DATASET", payload: dataset });
    },
    [],
  );

  const attachDataset = useCallback(
    async (id: string, dataset: WorkflowDataset) => {
      await window.sidebarAPI.setWorkflowDataset(id, dataset);
      const ws = await window.sidebarAPI.getAllWorkflows();
      dispatch({ type: "SET_WORKFLOWS", payload: ws });
    },
    [],
  );

  const clearDataset = useCallback(async (id: string) => {
    await window.sidebarAPI.clearWorkflowDataset(id);
    const ws = await window.sidebarAPI.getAllWorkflows();
    dispatch({ type: "SET_WORKFLOWS", payload: ws });
  }, []);

  const bindStepToColumn = useCallback(
    async (id: string, stepId: string, column: string | null) => {
      await window.sidebarAPI.bindStepToColumn(id, stepId, column);
    },
    [],
  );

  const fetchWorkflow = useCallback(async (id: string) => {
    return await window.sidebarAPI.getWorkflow(id);
  }, []);

  const refreshWorkflows = useCallback(async () => {
    const ws = await window.sidebarAPI.getAllWorkflows();
    dispatch({ type: "SET_WORKFLOWS", payload: ws });
  }, []);

  return (
    <WorkflowContext.Provider
      value={{
        recording: state.recording,
        workflows: state.workflows,
        isExecuting: state.isExecuting,
        recordingDataset: state.recordingDataset,
        bulkProgress: state.bulkProgress,
        bulkResult: state.bulkResult,
        startRecording,
        stopRecording,
        cancelRecording,
        addAnnotation,
        deleteWorkflow,
        renameWorkflow,
        executeWorkflow,
        executeBulkWorkflow,
        abortBulkWorkflow,
        setRecordingDataset,
        attachDataset,
        clearDataset,
        bindStepToColumn,
        fetchWorkflow,
        refreshWorkflows,
      }}
    >
      {children}
    </WorkflowContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components -- matches ChatContext/BrowserContext pattern
export const useWorkflow = (): WorkflowContextValue => {
  const ctx = useContext(WorkflowContext);
  if (!ctx) throw new Error("useWorkflow must be used within WorkflowProvider");
  return ctx;
};
