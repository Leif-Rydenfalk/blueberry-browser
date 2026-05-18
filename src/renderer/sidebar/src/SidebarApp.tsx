import React, { useState } from 'react'
import { AgentProvider } from './contexts/AgentContext'
import { WorkflowProvider } from './contexts/WorkflowContext'
import { AgentPanel } from './components/AgentPanel'
import { WorkflowPanel } from './components/WorkflowPanel'
import { useDarkMode } from '@common/hooks/useDarkMode'
import { cn } from '@common/lib/utils'

type Tab = 'agent' | 'workflows'

const SidebarContent: React.FC = () => {
  const { isDarkMode } = useDarkMode()
  const [activeTab, setActiveTab] = useState<Tab>('agent')

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode)
  }, [isDarkMode])

  return (
    <div className="h-screen flex flex-col bg-background border-l border-border/60">
      {/* Tab switcher */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-1 border-b border-border/50">
        <button
          onClick={() => setActiveTab('agent')}
          className={cn(
            "flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors",
            activeTab === 'agent'
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          )}
        >
          Agent
        </button>
        <button
          onClick={() => setActiveTab('workflows')}
          className={cn(
            "flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors",
            activeTab === 'workflows'
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          )}
        >
          Workflows
        </button>
      </div>

      {/* Panel content */}
      <div className="flex-1 min-h-0">
        {activeTab === 'agent' ? <AgentPanel /> : <WorkflowPanel />}
      </div>
    </div>
  )
}

export const SidebarApp: React.FC = () => (
  <AgentProvider>
    <WorkflowProvider>
      <SidebarContent />
    </WorkflowProvider>
  </AgentProvider>
)
