/* eslint-disable react-refresh/only-export-components */
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";

interface ConversationTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

// Compress large data in history entries so context stays token-efficient.
// Keeps prose text intact; replaces CSV blocks with a compact summary.
function compressForHistory(content: string): string {
  let compressed = content
    .replace(/```csv\n([\s\S]*?)```/gi, (_, csv: string) => {
      const lines = csv.trim().split("\n").filter(Boolean);
      const rowCount = Math.max(0, lines.length - 1);
      const header = lines[0] ?? "";
      return `[CSV data: ${rowCount} rows | columns: ${header}]`;
    })
    .trim();

  const MAX_CHARS = 2500;
  if (compressed.length > MAX_CHARS) {
    compressed = compressed.substring(0, MAX_CHARS) + "… [truncated]";
  }

  return compressed;
}

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

export type ApprovalDecision = "approve-once" | "approve-all" | "skip" | "stop";

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

export type LoginDecision = "signed-in" | "skip" | "stop";

export interface LoginRequiredRequest {
  id: string;
  sessionId: string;
  app: string;
  instructions: string;
  qrLogin: boolean;
  url: string | null;
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
  pendingLogin: LoginRequiredRequest | null;
  startAgent: (goal: string, attachments?: PromptAttachment[]) => Promise<void>;
  abortAgent: () => Promise<void>;
  sendMessage: (message: string) => Promise<void>;
  clearAgent: () => void;
  resolveApproval: (id: string, decision: ApprovalDecision) => Promise<void>;
  resolveScriptReview: (
    id: string,
    decision: "approve" | "reject",
    approvedScript?: string,
  ) => Promise<void>;
  resolveLogin: (id: string, decision: LoginDecision) => Promise<void>;
}

const AgentContext = createContext<AgentContextType | null>(null);

export const useAgent = (): AgentContextType => {
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
  const [pendingLogin, setPendingLogin] = useState<LoginRequiredRequest | null>(
    null,
  );
  // Accumulates user goals + agent final answers across runs in this session.
  const [sessionHistory, setSessionHistory] = useState<ConversationTurn[]>([]);
  const currentGoalRef = useRef<string>("");

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
      currentGoalRef.current = agentGoal;
      addUserMessage(agentGoal);

      setGoal(agentGoal);
      setIsRunning(true);
      setSteps([]);
      setCurrentStep(0);

      try {
        const result = await window.sidebarAPI.startAgentSession({
          goal: agentGoal,
          mode: "single-tab",
          attachments: attachments?.map(({ id: _id, ...rest }) => rest), // eslint-disable-line @typescript-eslint/no-unused-vars
          conversationHistory: sessionHistory,
        });
        setSessionId(result.sessionId);
      } catch (error) {
        console.error("Failed to start agent:", error);
        setIsRunning(false);
      }
    },
    [addUserMessage, sessionHistory],
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
    setPendingLogin(null);
    setSessionHistory([]);
    currentGoalRef.current = "";
  }, []);

  const resolveApproval = useCallback(
    async (id: string, decision: ApprovalDecision): Promise<void> => {
      try {
        await window.sidebarAPI.resolveAgentApproval(id, decision);
      } catch (error) {
        console.error("Failed to resolve approval:", error);
      } finally {
        setPendingApproval((current): ApprovalRequest | null =>
          current?.id === id ? null : current,
        );
      }
    },
    [],
  );

  const resolveLogin = useCallback(
    async (id: string, decision: LoginDecision): Promise<void> => {
      try {
        await window.sidebarAPI.resolveAgentLogin(id, decision);
      } catch (error) {
        console.error("Failed to resolve login:", error);
      } finally {
        setPendingLogin((current): LoginRequiredRequest | null =>
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
        setPendingScriptReview((current): ScriptReviewRequest | null =>
          current?.id === id ? null : current,
        );
      }
    },
    [],
  );

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC payload is untyped at the preload boundary
    const handleAgentUpdate = (data: any): void => {
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
        // Append this exchange to session history for future runs
        const capturedGoal = currentGoalRef.current;
        if (capturedGoal) {
          setSessionHistory((prev) => [
            ...prev,
            { role: "user", content: compressForHistory(capturedGoal) },
            { role: "assistant", content: compressForHistory(answer) },
          ]);
        }
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
    const handleLoginRequired = (request: LoginRequiredRequest): void => {
      setPendingLogin(request);
    };
    window.sidebarAPI.onAgentLoginRequired(handleLoginRequired);

    window.sidebarAPI
      .getPendingAgentLogin()
      .then((request) => {
        if (request) setPendingLogin(request);
      })
      .catch(() => {});

    return () => {
      window.sidebarAPI.removeAgentLoginRequiredListener();
    };
  }, []);

  useEffect(() => {
    const handleScriptReviewRequired = (request: ScriptReviewRequest): void => {
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
    pendingLogin,
    startAgent,
    abortAgent,
    sendMessage,
    clearAgent,
    resolveApproval,
    resolveScriptReview,
    resolveLogin,
  };

  return (
    <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
  );
};
