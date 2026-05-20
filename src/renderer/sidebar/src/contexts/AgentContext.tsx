/* eslint-disable react-refresh/only-export-components */
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";

export interface AgentStep {
  id: string;
  step: number;
  totalSteps: number;
  action: {
    type: string;
    params: Record<string, unknown>;
    reasoning: string;
  };
  status: "pending" | "running" | "success" | "error";
  result?: {
    success: boolean;
    data?: unknown;
    error?: string;
  };
  screenshot?: string;
  timestamp: number;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "agent-step";
  content: string;
  timestamp: number;
  stepData?: AgentStep;
}

export type ApprovalDecision =
  | "approve-once"
  | "approve-all"
  | "skip"
  | "stop";

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  action: {
    type: string;
    params: Record<string, unknown>;
    reasoning: string;
  };
  reason: string;
  matchedKeyword?: string;
  elementLabel?: string;
  previewData?: Record<string, unknown>;
  screenshot?: string;
  createdAt: number;
}

export interface ScriptReviewRequest {
  id: string;
  sessionId: string;
  script: string;
  description: string;
  name?: string;
  screenshot?: string;
  createdAt: number;
}

export interface PromptAttachment {
  id: string;
  type: "url" | "file";
  name: string;
  content?: string;
  url?: string;
  mimeType?: string;
}

interface AgentContextType {
  steps: AgentStep[];
  messages: AgentMessage[];
  isRunning: boolean;
  currentStep: number;
  maxSteps: number;
  goal: string;
  sessionId: string | null;
  pendingApproval: ApprovalRequest | null;
  pendingScriptReview: ScriptReviewRequest | null;
  startAgent: (goal: string, attachments?: PromptAttachment[]) => Promise<void>;
  abortAgent: () => Promise<void>;
  sendMessage: (message: string) => Promise<void>;
  clearAgent: () => void;
  resolveApproval: (
    id: string,
    decision: ApprovalDecision,
  ) => Promise<void>;
  resolveScriptReview: (
    id: string,
    decision: "approve" | "reject",
    approvedScript?: string,
  ) => Promise<void>;
}

const AgentContext = createContext<AgentContextType | null>(null);

export const useAgent = () => {
  const context = useContext(AgentContext);
  if (!context) {
    throw new Error("useAgent must be used within an AgentProvider");
  }
  return context;
};

export const AgentProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [maxSteps, setMaxSteps] = useState(15);
  const [goal, setGoal] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] =
    useState<ApprovalRequest | null>(null);
  const [pendingScriptReview, setPendingScriptReview] =
    useState<ScriptReviewRequest | null>(null);

  const addUserMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content,
        timestamp: Date.now(),
      },
    ]);
  }, []);

  const startAgent = useCallback(
    async (agentGoal: string, attachments?: PromptAttachment[]) => {
      addUserMessage(agentGoal);

      setGoal(agentGoal);
      setIsRunning(true);
      setSteps([]);
      setCurrentStep(0);

      try {
        const result = await window.sidebarAPI.startAgentSession({
          goal: agentGoal,
          mode: "single-tab",
          attachments: attachments?.map(({ id: _id, ...rest }) => rest),
        });
        setSessionId(result.sessionId);
      } catch (error) {
        console.error("Failed to start agent:", error);
        setIsRunning(false);
      }
    },
    [addUserMessage],
  );

  const abortAgent = useCallback(async () => {
    try {
      await window.sidebarAPI.abortAgentSession();
      setIsRunning(false);
    } catch (error) {
      console.error("Failed to abort agent:", error);
    }
  }, []);

  const sendMessage = useCallback(
    async (message: string) => {
      try {
        addUserMessage(message);
        await window.sidebarAPI.sendMessageToAgent(message);
      } catch (error) {
        console.error("Failed to send message to agent:", error);
      }
    },
    [addUserMessage],
  );

  const clearAgent = useCallback(() => {
    setSteps([]);
    setMessages([]);
    setIsRunning(false);
    setCurrentStep(0);
    setGoal("");
    setSessionId(null);
    setPendingApproval(null);
    setPendingScriptReview(null);
  }, []);

  const resolveApproval = useCallback(
    async (id: string, decision: ApprovalDecision): Promise<void> => {
      try {
        await window.sidebarAPI.resolveAgentApproval(id, decision);
      } catch (error) {
        console.error("Failed to resolve approval:", error);
      } finally {
        setPendingApproval(
          (current): ApprovalRequest | null =>
            current?.id === id ? null : current,
        );
      }
    },
    [],
  );

  const resolveScriptReview = useCallback(
    async (
      id: string,
      decision: "approve" | "reject",
      approvedScript?: string,
    ): Promise<void> => {
      try {
        await window.sidebarAPI.resolveAgentScriptReview(
          id,
          decision,
          approvedScript,
        );
      } catch (error) {
        console.error("Failed to resolve script review:", error);
      } finally {
        setPendingScriptReview(
          (current): ScriptReviewRequest | null =>
            current?.id === id ? null : current,
        );
      }
    },
    [],
  );

  useEffect(() => {
    const handleAgentUpdate = (data: any) => {
      console.log(
        "[AgentContext] Received update:",
        data.action?.type,
        data.status,
        "step:",
        data.step,
      );
      setCurrentStep(data.step);
      setMaxSteps(data.totalSteps);

      const newStep: AgentStep = {
        id: `${data.sessionId}-${data.step}`,
        step: data.step,
        totalSteps: data.totalSteps,
        action: data.action,
        status: data.status,
        result: data.result,
        screenshot: data.screenshot,
        timestamp: Date.now(),
      };

      setSteps((prev) => {
        const existingIndex = prev.findIndex((s) => s.step === data.step);
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = newStep;
          return updated;
        }
        return [...prev, newStep];
      });

      setMessages((prev) => {
        const messageId = `step-${data.sessionId}-${data.step}`;
        const existingIndex = prev.findIndex((m) => m.id === messageId);
        const content = `Step ${data.step}/${data.totalSteps}: ${data.action.type}`;
        const nextMessage: AgentMessage = {
          id: messageId,
          role: "agent-step",
          content,
          timestamp:
            existingIndex >= 0 ? prev[existingIndex].timestamp : Date.now(),
          stepData: newStep,
        };

        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = nextMessage;
          return updated;
        }
        return [...prev, nextMessage];
      });

      if (
        (data.status === "success" || data.status === "error") &&
        data.action.type === "finish"
      ) {
        setIsRunning(false);
        // Add assistant message with the answer
        const answer = data.action.params?.answer || "Task completed";
        setMessages((prev) => [
          ...prev,
          {
            id: `finish-${Date.now()}`,
            role: "assistant",
            content: answer,
            timestamp: Date.now(),
          },
        ]);
      }
    };

    window.sidebarAPI.onAgentUpdate(handleAgentUpdate);

    return () => {
      window.sidebarAPI.removeAgentUpdateListener();
    };
  }, []);

  useEffect(() => {
    const handleApprovalRequired = (request: ApprovalRequest): void => {
      setPendingApproval(request);
    };
    window.sidebarAPI.onAgentApprovalRequired(handleApprovalRequired);

    // Recover from a remount mid-gate.
    window.sidebarAPI
      .getPendingAgentApproval()
      .then((request) => {
        if (request) setPendingApproval(request);
      })
      .catch(() => {});

    return () => {
      window.sidebarAPI.removeAgentApprovalRequiredListener();
    };
  }, []);

  useEffect(() => {
    const handleScriptReviewRequired = (
      request: ScriptReviewRequest,
    ): void => {
      setPendingScriptReview(request);
    };
    window.sidebarAPI.onAgentScriptReviewRequired(handleScriptReviewRequired);

    window.sidebarAPI
      .getPendingAgentScriptReview()
      .then((request) => {
        if (request) setPendingScriptReview(request);
      })
      .catch(() => {});

    return () => {
      window.sidebarAPI.removeAgentScriptReviewRequiredListener();
    };
  }, []);

  const value: AgentContextType = {
    steps,
    messages,
    isRunning,
    currentStep,
    maxSteps,
    goal,
    sessionId,
    pendingApproval,
    pendingScriptReview,
    startAgent,
    abortAgent,
    sendMessage,
    clearAgent,
    resolveApproval,
    resolveScriptReview,
  };

  return (
    <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
  );
};
