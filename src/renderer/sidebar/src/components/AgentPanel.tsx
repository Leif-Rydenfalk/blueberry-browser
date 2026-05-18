import React, { useState, useRef, useEffect } from 'react'
import { useAgent } from '../contexts/AgentContext'
import { useChat } from '../contexts/ChatContext'
import { Play, Square, RotateCcw, ChevronDown, ChevronUp, CheckCircle2, XCircle, Loader2, MousePointer, Type, ScrollText, Camera, Navigation, Search, Flag, Send, Bot, User } from 'lucide-react'
import { cn } from '@common/lib/utils'
import { Button } from '@common/components/Button'

interface UnifiedMessage {
  id: string
  role: 'user' | 'assistant' | 'agent-step'
  content: string
  timestamp: number
  stepData?: {
    step: number
    totalSteps: number
    action: { type: string; params: Record<string, unknown>; reasoning: string }
    status: string
    result?: { success: boolean; data?: unknown; error?: string }
    screenshot?: string
  }
}

const ActionIcon: React.FC<{ type: string }> = ({ type }) => {
  switch (type) {
    case 'navigate': return <Navigation className="size-3" />
    case 'click': return <MousePointer className="size-3" />
    case 'type': return <Type className="size-3" />
    case 'scroll': return <ScrollText className="size-3" />
    case 'screenshot': return <Camera className="size-3" />
    case 'extract': return <Search className="size-3" />
    case 'finish': return <Flag className="size-3" />
    default: return <div className="size-3 rounded-full bg-muted" />
  }
}

const StatusIcon: React.FC<{ status: string }> = ({ status }) => {
  switch (status) {
    case 'success': return <CheckCircle2 className="size-3 text-green-500" />
    case 'error': return <XCircle className="size-3 text-red-500" />
    case 'running': return <Loader2 className="size-3 text-primary animate-spin" />
    case 'pending': return <div className="size-3 rounded-full border-2 border-muted-foreground/30" />
    default: return null
  }
}

const AgentStepMessage: React.FC<{ stepData: UnifiedMessage['stepData'] }> = ({ stepData }) => {
  const [expanded, setExpanded] = useState(false)
  const [showScreenshot, setShowScreenshot] = useState(false)

  if (!stepData) return null

  const getActionSummary = () => {
    switch (stepData.action.type) {
      case 'navigate': return `Navigate to ${(stepData.action.params as any).url}`
      case 'click': return `Click ${(stepData.action.params as any).selector}`
      case 'type': return `Type "${(stepData.action.params as any).text}"`
      case 'scroll': return `Scroll ${(stepData.action.params as any).direction}`
      case 'extract': return `Extract ${(stepData.action.params as any).name}`
      case 'screenshot': return 'Screenshot'
      case 'finish': return 'Done'
      default: return stepData.action.type
    }
  }

  return (
    <div className="ml-8 mt-1 mb-2">
      <div
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 rounded-lg cursor-pointer text-xs",
          "bg-muted/30 hover:bg-muted/50 transition-colors",
          stepData.status === 'running' && "bg-primary/5"
        )}
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon status={stepData.status} />
        <ActionIcon type={stepData.action.type} />
        <span className="font-medium">{getActionSummary()}</span>
        <span className="text-muted-foreground ml-auto">{stepData.step}/{stepData.totalSteps}</span>
        {expanded ? <ChevronUp className="size-3 text-muted-foreground" /> : <ChevronDown className="size-3 text-muted-foreground" />}
      </div>

      {expanded && (
        <div className="ml-4 mt-1 space-y-1 text-xs">
          <div className="text-muted-foreground">{stepData.action.reasoning}</div>
          {stepData.result && !stepData.result.success && (
            <div className="text-red-500">{stepData.result.error}</div>
          )}
          {stepData.screenshot && (
            <div>
              <button onClick={() => setShowScreenshot(!showScreenshot)} className="text-primary hover:underline">
                {showScreenshot ? 'Hide' : 'Show'} screenshot
              </button>
              {showScreenshot && (
                <img src={stepData.screenshot} alt="screenshot" className="mt-1 rounded-lg border max-w-full" />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const AgentPanel: React.FC = () => {
  const { steps, isRunning, currentStep, maxSteps, goal, startAgent, abortAgent, sendMessage, clearAgent } = useAgent()
  const { messages: chatMessages, sendMessage: sendChatMessage } = useChat()
  const [input, setInput] = useState('')
  const [unifiedMessages, setUnifiedMessages] = useState<UnifiedMessage[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Build unified message list from chat + agent steps
  useEffect(() => {
    const msgs: UnifiedMessage[] = []

    // Add chat messages
    chatMessages.forEach((msg, i) => {
      msgs.push({
        id: `chat-${i}`,
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        timestamp: msg.timestamp || Date.now(),
      })
    })

    // Add agent steps as inline messages
    steps.forEach((step) => {
      msgs.push({
        id: step.id,
        role: 'agent-step',
        content: `${step.action.type}: ${step.action.reasoning}`,
        timestamp: step.timestamp,
        stepData: {
          step: step.step,
          totalSteps: step.totalSteps,
          action: step.action,
          status: step.status,
          result: step.result,
          screenshot: step.screenshot,
        }
      })
    })

    msgs.sort((a, b) => a.timestamp - b.timestamp)
    setUnifiedMessages(msgs)
  }, [chatMessages, steps])

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [unifiedMessages])

  const handleSubmit = async () => {
    if (!input.trim()) return

    const text = input.trim()
    setInput('')

    if (isRunning) {
      // Send to running agent
      await sendMessage(text)
    } else {
      // Check if message looks like an agent task
      const agentKeywords = ['find', 'search', 'go to', 'navigate', 'look for', 'hitta', 'sök', 'gå till']
      const looksLikeAgentTask = agentKeywords.some(kw => text.toLowerCase().includes(kw))

      if (looksLikeAgentTask) {
        await startAgent(text)
      } else {
        // Regular chat
        await sendChatMessage(text)
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <div className="size-7 rounded-lg bg-primary/10 flex items-center justify-center">
            <Bot className="size-4 text-primary" />
          </div>
          <div>
            <span className="text-sm font-semibold">Blueberry AI</span>
            {isRunning && (
              <span className="ml-2 text-xs text-primary animate-pulse">● working</span>
            )}
          </div>
        </div>
        {isRunning && (
          <Button onClick={abortAgent} variant="destructive" size="sm" className="h-7 text-xs gap-1">
            <Square className="size-3" /> Stop
          </Button>
        )}
      </div>

      {/* Progress bar when running */}
      {isRunning && (
        <div className="px-4 py-1.5 bg-primary/5 border-b border-border/30">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-muted-foreground">{goal}</span>
            <span className="text-primary font-medium">{currentStep}/{maxSteps}</span>
          </div>
          <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${(currentStep / maxSteps) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Debug: Show raw steps if nothing else renders */}
      {steps.length > 0 && unifiedMessages.length === 0 && (
        <div className="p-4 text-xs text-red-500">
          Steps exist but not rendered: {steps.length} steps
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {steps.length === 0 && !isRunning && unifiedMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full min-h-[200px]">
            <div className="text-center space-y-3">
              <div className="text-4xl">🫐</div>
              <h3 className="text-sm font-semibold">Blueberry AI</h3>
              <p className="text-muted-foreground text-xs max-w-[240px]">
                Ask me anything, or tell me to browse the web for you.
              </p>
              <div className="space-y-1 text-xs text-muted-foreground/60">
                <p>"Find the cheapest flight to London"</p>
                <p>"Go to Reddit and find top posts"</p>
                <p>"What's the weather in Stockholm?"</p>
              </div>
            </div>
          </div>
        ) : (
          unifiedMessages.map((msg) => {
            if (msg.role === 'agent-step') {
              return <AgentStepMessage key={msg.id} stepData={msg.stepData} />
            }

            return (
              <div key={msg.id} className={cn(
                "flex gap-2",
                msg.role === 'user' ? "justify-end" : "justify-start"
              )}>
                {msg.role === 'assistant' && (
                  <div className="size-6 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-1">
                    <Bot className="size-3.5 text-primary" />
                  </div>
                )}
                <div className={cn(
                  "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                  msg.role === 'user'
                    ? "bg-primary text-primary-foreground rounded-tr-sm"
                    : "bg-muted/50 text-foreground rounded-tl-sm"
                )}>
                  {msg.content}
                </div>
                {msg.role === 'user' && (
                  <div className="size-6 rounded-md bg-secondary flex items-center justify-center shrink-0 mt-1">
                    <User className="size-3.5" />
                  </div>
                )}
              </div>
            )
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-border/50 bg-background/80 backdrop-blur-sm">
        <div className="relative flex items-end gap-2 bg-secondary/60 dark:bg-secondary/30 rounded-2xl px-3 py-2 border border-border/40 focus-within:border-primary/30 focus-within:ring-1 focus-within:ring-primary/20 transition-all">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRunning ? "Send a message to the agent..." : "Ask anything or tell me to browse..."}
            className="flex-1 resize-none outline-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground min-h-[20px] max-h-[120px] py-1"
            rows={1}
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim()}
            className={cn(
              "size-8 rounded-xl flex items-center justify-center shrink-0 transition-all",
              "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed shadow-sm"
            )}
          >
            <Send className="size-4" />
          </button>
        </div>
        {isRunning && (
          <div className="mt-1.5 text-xs text-muted-foreground text-center">
            Agent is running. Type to send instructions or questions.
          </div>
        )}
      </div>
    </div>
  )
}