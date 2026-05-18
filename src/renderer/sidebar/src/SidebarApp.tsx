import React from 'react'
import { AgentProvider } from './contexts/AgentContext'
import { AgentPanel } from './components/AgentPanel'
import { useDarkMode } from '@common/hooks/useDarkMode'

const SidebarContent: React.FC = () => {
    const { isDarkMode } = useDarkMode()

    React.useEffect(() => {
        document.documentElement.classList.toggle('dark', isDarkMode)
    }, [isDarkMode])

    return (
        <div className="h-screen flex flex-col bg-background border-l border-border/60">
            <AgentPanel />
        </div>
    )
}

export const SidebarApp: React.FC = () => (
    <AgentProvider>
        <SidebarContent />
    </AgentProvider>
)