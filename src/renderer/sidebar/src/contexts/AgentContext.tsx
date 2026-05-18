import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'

interface AgentStep {
  id: string
  step: number
  totalSteps: number
  action: {
    type: string
    params: Record<string, unknown>
    reasoning: string
  }
  status: 'pending' | 'running' | 'success' | 'error'
  result?: {
    success: boolean
    data?: unknown
    error?: string
  }
  screenshot?: string
  timestamp: number
}

interface AgentContextType {
  steps: AgentStep[]
  isRunning: boolean
  currentStep: number
  maxSteps: number
  goal: string
  sessionId: string | null
  startAgent: (goal: string) => Promise<void>
  abortAgent: () => Promise<void>
  sendMessage: (message: string) => Promise<void>
  clearAgent: () => void
}

const AgentContext = createContext<AgentContextType | null>(null)

export const useAgent = () => {
  const context = useContext(AgentContext)
  if (!context) {
    throw new Error('useAgent must be used within an AgentProvider')
  }
  return context
}

export const AgentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [steps, setSteps] = useState<AgentStep[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [maxSteps, setMaxSteps] = useState(15)
  const [goal, setGoal] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)

  const startAgent = useCallback(async (agentGoal: string) => {
    setGoal(agentGoal)
    setIsRunning(true)
    setSteps([])
    setCurrentStep(0)

    try {
      const result = await window.sidebarAPI.startAgentSession({
        goal: agentGoal,
        mode: 'single-tab'
      })
      setSessionId(result.sessionId)
    } catch (error) {
      console.error('Failed to start agent:', error)
      setIsRunning(false)
    }
  }, [])

  const abortAgent = useCallback(async () => {
    try {
      await window.sidebarAPI.abortAgentSession()
      setIsRunning(false)
    } catch (error) {
      console.error('Failed to abort agent:', error)
    }
  }, [])

  const sendMessage = useCallback(async (message: string) => {
    try {
      await window.sidebarAPI.sendMessageToAgent(message)
    } catch (error) {
      console.error('Failed to send message to agent:', error)
    }
  }, [])

  const clearAgent = useCallback(() => {
    setSteps([])
    setIsRunning(false)
    setCurrentStep(0)
    setGoal('')
    setSessionId(null)
  }, [])

  useEffect(() => {
    const handleAgentUpdate = (data: any) => {
      console.log("[AgentContext] Received update:", data.action?.type, data.status, "step:", data.step);
      setCurrentStep(data.step)
      setMaxSteps(data.totalSteps)

      setSteps(prev => {
        const existingIndex = prev.findIndex(s => s.step === data.step)
        const newStep: AgentStep = {
          id: `${data.sessionId}-${data.step}`,
          step: data.step,
          totalSteps: data.totalSteps,
          action: data.action,
          status: data.status,
          result: data.result,
          screenshot: data.screenshot,
          timestamp: Date.now()
        }

        if (existingIndex >= 0) {
          const updated = [...prev]
          updated[existingIndex] = newStep
          return updated
        } else {
          return [...prev, newStep]
        }
      })

      if (data.status === 'success' && data.action.type === 'finish') {
        setIsRunning(false)
      }
    }

    window.sidebarAPI.onAgentUpdate(handleAgentUpdate)

    return () => {
      window.sidebarAPI.removeAgentUpdateListener()
    }
  }, [])

  const value: AgentContextType = {
    steps,
    isRunning,
    currentStep,
    maxSteps,
    goal,
    sessionId,
    startAgent,
    abortAgent,
    sendMessage,
    clearAgent
  }

  return (
    <AgentContext.Provider value={value}>
      {children}
    </AgentContext.Provider>
  )
}
