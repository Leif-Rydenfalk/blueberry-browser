import React, { useState, useRef, useLayoutEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { ArrowUp, Plus } from "lucide-react";
import { useChat } from "../contexts/ChatContext";
import { cn } from "@common/lib/utils";
import { Button } from "@common/components/Button";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

const useAutoScroll = (messages: Message[]) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);
  useLayoutEffect(() => {
    if (messages.length > prevCount.current) {
      setTimeout(
        () =>
          scrollRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "end",
          }),
        50,
      );
    }
    prevCount.current = messages.length;
  }, [messages.length]);
  return scrollRef;
};

const UserMessage: React.FC<{ content: string }> = ({ content }) => (
  <div className="flex justify-end mb-4">
    <div className="max-w-[85%] bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed shadow-sm">
      {content}
    </div>
  </div>
);

const AssistantMessage: React.FC<{ content: string }> = ({ content }) => (
  <div className="flex justify-start mb-4">
    <div className="max-w-[90%] text-foreground text-sm leading-relaxed">
      <div
        className="prose prose-sm dark:prose-invert max-w-none
                prose-headings:text-foreground prose-p:text-foreground prose-strong:text-foreground
                prose-a:text-primary hover:prose-a:underline
                prose-code:bg-secondary prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:text-xs prose-code:font-mono
                prose-pre:bg-secondary dark:prose-pre:bg-secondary/50 prose-pre:p-3 prose-pre:rounded-xl prose-pre:text-xs"
      >
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  </div>
);

const ChatInput: React.FC<{
  onSend: (msg: string) => void;
  disabled: boolean;
}> = ({ onSend, disabled }) => {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = () => {
    if (value.trim() && !disabled) {
      onSend(value.trim());
      setValue("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="p-3 border-t border-border/50 bg-background/80 backdrop-blur-sm">
      <div className="relative flex items-end gap-2 bg-secondary/60 dark:bg-secondary/30 rounded-2xl px-3 py-2 border border-border/40 focus-within:border-primary/30 focus-within:ring-1 focus-within:ring-primary/20 transition-all">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything..."
          className="flex-1 resize-none outline-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground min-h-[20px] max-h-[120px] py-1"
          rows={1}
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          className={cn(
            "size-8 rounded-xl flex items-center justify-center shrink-0 transition-all",
            "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed shadow-sm",
          )}
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  );
};

export const Chat: React.FC = () => {
  const { messages, isLoading, sendMessage, clearChat } = useChat();
  const scrollRef = useAutoScroll(messages);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <div className="size-7 rounded-lg bg-primary/10 flex items-center justify-center text-base">
            🫐
          </div>
          <span className="text-sm font-semibold">Blueberry Browser</span>
        </div>
        {messages.length > 0 && (
          <Button
            onClick={clearChat}
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1"
          >
            <Plus className="size-3" /> New
          </Button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full min-h-[300px]">
            <div className="text-center space-y-3">
              <div className="text-5xl">🫐</div>
              <h3 className="text-lg font-semibold">Blueberry AI</h3>
              <p className="text-muted-foreground text-sm max-w-[200px]">
                Ask me about the current page, or anything else.
              </p>
              <p className="text-xs text-muted-foreground/60">
                Press ⌘E to toggle
              </p>
            </div>
          </div>
        ) : (
          messages.map((msg) =>
            msg.role === "user" ? (
              <UserMessage key={msg.id} content={msg.content} />
            ) : (
              <AssistantMessage key={msg.id} content={msg.content} />
            ),
          )
        )}
        {isLoading && messages[messages.length - 1]?.role === "user" && (
          <div className="flex justify-start mb-4">
            <div className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-secondary/50">
              <div
                className="size-1.5 rounded-full bg-primary animate-bounce"
                style={{ animationDelay: "0ms" }}
              />
              <div
                className="size-1.5 rounded-full bg-primary animate-bounce"
                style={{ animationDelay: "150ms" }}
              />
              <div
                className="size-1.5 rounded-full bg-primary animate-bounce"
                style={{ animationDelay: "300ms" }}
              />
            </div>
          </div>
        )}
        <div ref={scrollRef} />
      </div>

      <ChatInput onSend={sendMessage} disabled={isLoading} />
    </div>
  );
};
