import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  isStreaming?: boolean;
}

// Shape of CoreMessage payloads received from main over IPC. Mirrors the AI
// SDK's CoreMessage subset we actually consume — content is either a plain
// string or an array of parts where text is the only kind we render.
interface CoreMessageLike {
  readonly role: "user" | "assistant";
  readonly content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

function coreToFrontend(messages: ReadonlyArray<CoreMessageLike>): Message[] {
  return messages.map((msg, index) => ({
    id: `msg-${index}`,
    role: msg.role,
    content:
      typeof msg.content === "string"
        ? msg.content
        : (msg.content.find((p) => p.type === "text")?.text ?? ""),
    timestamp: Date.now(),
    isStreaming: false,
  }));
}

interface ChatContextType {
  messages: Message[];
  isLoading: boolean;

  // Chat actions
  sendMessage: (content: string) => Promise<void>;
  clearChat: () => void;

  // Page content access
  getPageContent: () => Promise<string | null>;
  getPageText: () => Promise<string | null>;
  getCurrentUrl: () => Promise<string | null>;
}

const ChatContext = createContext<ChatContextType | null>(null);

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChat must be used within a ChatProvider");
  }
  return context;
};

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Load initial messages from main process
  useEffect(() => {
    const loadMessages = async () => {
      try {
        const storedMessages =
          (await window.sidebarAPI.getMessages()) as ReadonlyArray<CoreMessageLike>;
        if (storedMessages && storedMessages.length > 0) {
          setMessages(coreToFrontend(storedMessages));
        }
      } catch (error) {
        console.error("Failed to load messages:", error);
      }
    };
    loadMessages();
  }, []);

  const sendMessage = useCallback(async (content: string) => {
    setIsLoading(true);

    try {
      const messageId = Date.now().toString();

      // Send message to main process (which will handle context)
      await window.sidebarAPI.sendChatMessage({
        message: content,
        messageId: messageId,
      });

      // Messages will be updated via the chat-messages-updated event
    } catch (error) {
      console.error("Failed to send message:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const clearChat = useCallback(async () => {
    try {
      await window.sidebarAPI.clearChat();
      setMessages([]);
    } catch (error) {
      console.error("Failed to clear chat:", error);
    }
  }, []);

  const getPageContent = useCallback(async () => {
    try {
      return await window.sidebarAPI.getPageContent();
    } catch (error) {
      console.error("Failed to get page content:", error);
      return null;
    }
  }, []);

  const getPageText = useCallback(async () => {
    try {
      return await window.sidebarAPI.getPageText();
    } catch (error) {
      console.error("Failed to get page text:", error);
      return null;
    }
  }, []);

  const getCurrentUrl = useCallback(async () => {
    try {
      return await window.sidebarAPI.getCurrentUrl();
    } catch (error) {
      console.error("Failed to get current URL:", error);
      return null;
    }
  }, []);

  // Set up message listeners
  useEffect(() => {
    // Listen for streaming response updates
    const handleChatResponse = (data: {
      messageId: string;
      content: string;
      isComplete: boolean;
    }) => {
      if (data.isComplete) {
        setIsLoading(false);
      }
    };

    // Listen for message updates from main process. The preload signature
    // declares `unknown[]` at the IPC boundary; narrow once here.
    const handleMessagesUpdated = (updatedMessages: unknown[]): void => {
      setMessages(
        coreToFrontend(updatedMessages as ReadonlyArray<CoreMessageLike>),
      );
    };

    window.sidebarAPI.onChatResponse(handleChatResponse);
    window.sidebarAPI.onMessagesUpdated(handleMessagesUpdated);

    return () => {
      window.sidebarAPI.removeChatResponseListener();
      window.sidebarAPI.removeMessagesUpdatedListener();
    };
  }, []);

  const value: ChatContextType = {
    messages,
    isLoading,
    sendMessage,
    clearChat,
    getPageContent,
    getPageText,
    getCurrentUrl,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};
