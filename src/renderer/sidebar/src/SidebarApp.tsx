import React, { useEffect } from 'react'
import { ChatProvider } from './contexts/ChatContext'
import { Chat } from './components/Chat'
import { useDarkMode } from '@common/hooks/useDarkMode'

const SidebarContent: React.FC = () => {
    const { isDarkMode } = useDarkMode()

    useEffect(() => {
        document.documentElement.classList.toggle('dark', isDarkMode)
    }, [isDarkMode])

    return (
        <div className="h-screen flex flex-col bg-background border-l border-border/60">
            <Chat />
        </div>
    )
}

export const SidebarApp: React.FC = () => (
    <ChatProvider>
        <SidebarContent />
    </ChatProvider>
)