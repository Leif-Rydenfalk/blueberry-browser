import React, { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { useAgent } from '../contexts/AgentContext'
import type { AgentStep } from '../contexts/AgentContext'
import { Square, ChevronDown, ChevronUp, CheckCircle2, XCircle, Loader2, MousePointer, Type, ScrollText, Camera, Navigation, Search, Flag, Send, Bot, User } from 'lucide-react'
import { cn } from '@common/lib/utils'
import { Button } from '@common/components/Button'

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

const MarkdownMessage: React.FC<{ content: string }> = ({ content }) => (
  <div className="prose prose-sm dark:prose-invert max-w-none
    prose-headings:text-foreground prose-p:text-foreground prose-strong:text-foreground
    prose-a:text-primary hover:prose-a:underline
    prose-code:bg-secondary prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:text-xs prose-code:font-mono
    prose-pre:bg-secondary dark:prose-pre:bg-secondary/50 prose-pre:p-3 prose-pre:rounded-xl prose-pre:text-xs">
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{content}</ReactMarkdown>
  </div>
)

const getActionSummary = (step: AgentStep) => {
  switch (step.action.type) {
    case 'navigate': return `Navigate to ${(step.action.params as any).url || 'page'}`
    case 'click': return `Click ${(step.action.params as any).selector || 'coordinates'}`
    case 'type': return `Type "${(step.action.params as any).text || ''}"`
    case 'scroll': return `Scroll ${(step.action.params as any).direction || ''}`
    case 'extract': return `Extract ${(step.action.params as any).name || 'data'}`
    case 'screenshot': return 'Screenshot'
    case 'finish': return 'Done'
    default: return step.action.type
  }
}

const AgentStepMessage: React.FC<{
  step: AgentStep
  expanded: boolean
  onToggle: () => void
}> = ({ step, expanded, onToggle }) => (
  <div className="ml-8">
    <div
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 rounded-lg cursor-pointer text-xs",
        "bg-muted/30 hover:bg-muted/50 transition-colors",
        step.status === 'running' && "bg-primary/5"
      )}
      onClick={onToggle}
    >
      <StatusIcon status={step.status} />
      <ActionIcon type={step.action.type} />
      <span className="font-medium truncate">{getActionSummary(step)}</span>
      <span className="text-muted-foreground ml-auto shrink-0">{step.step}/{step.totalSteps}</span>
      {expanded ? <ChevronUp className="size-3 text-muted-foreground shrink-0" /> : <ChevronDown className="size-3 text-muted-foreground shrink-0" />}
    </div>

    {expanded && (
      <div className="ml-4 mt-1 space-y-2 text-xs">
        {step.action.reasoning && (
          <div className="text-muted-foreground">{step.action.reasoning}</div>
        )}
        {step.result && !step.result.success && (
          <div className="text-red-500">{step.result.error}</div>
        )}
        {step.result?.success && step.result.data !== undefined && (
          <pre className="max-h-40 overflow-auto rounded-lg bg-secondary/60 p-2 text-[11px] text-muted-foreground">
            {typeof step.result.data === 'string' ? step.result.data : JSON.stringify(step.result.data, null, 2)}
          </pre>
        )}
        {step.screenshot && (
          <img src={step.screenshot} alt={`Step ${step.step} screenshot`} className="mt-1 rounded-lg border max-w-full" />
        )}
      </div>
    )}
  </div>
)

export const AgentPanel: React.FC = () => {
  const { messages, isRunning, currentStep, maxSteps, goal, startAgent, abortAgent, sendMessage, clearAgent } = useAgent()
  const [input, setInput] = useState('')
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const toggleStep = (stepId: string) => {
    setExpandedSteps(prev => {
      const next = new Set(prev)
      if (next.has(stepId)) next.delete(stepId)
      else next.add(stepId)
      return next
    })
  }

  const handleSubmit = async () => {
    if (!input.trim()) return
    const text = input.trim()
    setInput('')
    if (isRunning) {
      await sendMessage(text)
    } else {
      await startAgent(text)
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
        <div className="flex items-center gap-2">
          {messages.length > 0 && !isRunning && (
            <Button onClick={clearAgent} variant="ghost" size="sm" className="h-7 text-xs gap-1">
              <Square className="size-3" /> Clear
            </Button>
          )}
          {isRunning && (
            <Button onClick={abortAgent} variant="destructive" size="sm" className="h-7 text-xs gap-1">
              <Square className="size-3" /> Stop
            </Button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {isRunning && (
        <div className="px-4 py-1.5 bg-primary/5 border-b border-border/30">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-muted-foreground truncate max-w-[200px]">{goal}</span>
            <span className="text-primary font-medium">Step {currentStep} of {maxSteps}</span>
          </div>
          <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${(currentStep / maxSteps) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full min-h-[200px]">
            <div className="text-center space-y-3">
              <div className="text-4xl">🫐</div>
              <h3 className="text-sm font-semibold">Blueberry AI</h3>
              <p className="text-muted-foreground text-xs max-w-[240px]">
                Ask me anything. I'll browse the web to find answers.
              </p>
              <div className="space-y-1 text-xs text-muted-foreground/60">
                <p>"What's the cheapest flight to London?"</p>
                <p>"Find my important emails"</p>
                <p>"Hi" — I'll just say hello back!</p>
              </div>
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.role === 'agent-step' && msg.stepData) {
              const isExpanded = expandedSteps.has(msg.stepData.id)
              return (
                <AgentStepMessage
                  key={msg.id}
                  step={msg.stepData}
                  expanded={isExpanded}
                  onToggle={() => toggleStep(msg.stepData!.id)}
                />
              )
            }

            // Regular message
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
                  {msg.role === 'assistant' ? (
                    <MarkdownMessage content={msg.content} />
                  ) : (
                    msg.content
                  )}
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
            placeholder={isRunning ? "Send a message..." : "Ask anything..."}
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
      </div>
    </div>
  )
}
