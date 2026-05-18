import React, { createContext, useContext, useEffect, useReducer, useCallback } from 'react'

interface RecordingState {
  isRecording: boolean
  startedAt: number | null
  stepCount: number
  currentUrl: string | null
}

interface WorkflowSummary {
  id: string
  name: string
  description?: string
  createdAt: number
  duration: number
  stepCount: number
  startUrl: string
  endUrl: string
}

interface WorkflowContextValue {
  recording: RecordingState
  workflows: WorkflowSummary[]
  isExecuting: boolean
  startRecording: () => Promise<void>
  stopRecording: (name: string) => Promise<void>
  cancelRecording: () => Promise<void>
  addAnnotation: (text: string) => Promise<void>
  deleteWorkflow: (id: string) => Promise<void>
  renameWorkflow: (id: string, name: string) => Promise<void>
  executeWorkflow: (id: string, goalOverride?: string) => Promise<void>
  refreshWorkflows: () => Promise<void>
}

interface State {
  recording: RecordingState
  workflows: WorkflowSummary[]
  isExecuting: boolean
}

type Action =
  | { type: 'SET_RECORDING'; payload: RecordingState }
  | { type: 'SET_WORKFLOWS'; payload: WorkflowSummary[] }
  | { type: 'DELETE_WORKFLOW'; payload: string }
  | { type: 'RENAME_WORKFLOW'; payload: { id: string; name: string } }
  | { type: 'SET_EXECUTING'; payload: boolean }

const initialRecording: RecordingState = {
  isRecording: false,
  startedAt: null,
  stepCount: 0,
  currentUrl: null,
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_RECORDING':
      return { ...state, recording: action.payload }
    case 'SET_WORKFLOWS':
      return { ...state, workflows: action.payload }
    case 'DELETE_WORKFLOW':
      return { ...state, workflows: state.workflows.filter(w => w.id !== action.payload) }
    case 'RENAME_WORKFLOW':
      return {
        ...state,
        workflows: state.workflows.map(w =>
          w.id === action.payload.id ? { ...w, name: action.payload.name } : w
        ),
      }
    case 'SET_EXECUTING':
      return { ...state, isExecuting: action.payload }
  }
}

const WorkflowContext = createContext<WorkflowContextValue | null>(null)

export const WorkflowProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(reducer, {
    recording: initialRecording,
    workflows: [],
    isExecuting: false,
  })

  useEffect(() => {
    // Sync initial state
    window.sidebarAPI.getWorkflowRecordingState().then(s => {
      dispatch({ type: 'SET_RECORDING', payload: s })
    })
    window.sidebarAPI.getAllWorkflows().then(ws => {
      dispatch({ type: 'SET_WORKFLOWS', payload: ws })
    })

    window.sidebarAPI.onWorkflowRecordingUpdate(s => {
      dispatch({ type: 'SET_RECORDING', payload: s })
    })

    return () => {
      window.sidebarAPI.removeWorkflowRecordingUpdateListener()
    }
  }, [])

  const startRecording = useCallback(async () => {
    const state = await window.sidebarAPI.startWorkflowRecording()
    dispatch({ type: 'SET_RECORDING', payload: state })
  }, [])

  const stopRecording = useCallback(async (name: string) => {
    await window.sidebarAPI.stopWorkflowRecording(name)
    const ws = await window.sidebarAPI.getAllWorkflows()
    dispatch({ type: 'SET_WORKFLOWS', payload: ws })
  }, [])

  const cancelRecording = useCallback(async () => {
    await window.sidebarAPI.cancelWorkflowRecording()
  }, [])

  const addAnnotation = useCallback(async (text: string) => {
    await window.sidebarAPI.addWorkflowAnnotation(text)
  }, [])

  const deleteWorkflow = useCallback(async (id: string) => {
    await window.sidebarAPI.deleteWorkflow(id)
    dispatch({ type: 'DELETE_WORKFLOW', payload: id })
  }, [])

  const renameWorkflow = useCallback(async (id: string, name: string) => {
    await window.sidebarAPI.renameWorkflow(id, name)
    dispatch({ type: 'RENAME_WORKFLOW', payload: { id, name } })
  }, [])

  const executeWorkflow = useCallback(async (id: string, goalOverride?: string) => {
    dispatch({ type: 'SET_EXECUTING', payload: true })
    try {
      await window.sidebarAPI.executeWorkflow(id, goalOverride)
    } finally {
      dispatch({ type: 'SET_EXECUTING', payload: false })
    }
  }, [])

  const refreshWorkflows = useCallback(async () => {
    const ws = await window.sidebarAPI.getAllWorkflows()
    dispatch({ type: 'SET_WORKFLOWS', payload: ws })
  }, [])

  return (
    <WorkflowContext.Provider value={{
      recording: state.recording,
      workflows: state.workflows,
      isExecuting: state.isExecuting,
      startRecording,
      stopRecording,
      cancelRecording,
      addAnnotation,
      deleteWorkflow,
      renameWorkflow,
      executeWorkflow,
      refreshWorkflows,
    }}>
      {children}
    </WorkflowContext.Provider>
  )
}

export const useWorkflow = (): WorkflowContextValue => {
  const ctx = useContext(WorkflowContext)
  if (!ctx) throw new Error('useWorkflow must be used within WorkflowProvider')
  return ctx
}
