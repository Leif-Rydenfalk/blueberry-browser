import React, { useState } from "react";
import { AgentProvider } from "./contexts/AgentContext";
import { WorkflowProvider } from "./contexts/WorkflowContext";
import { AgentPanel } from "./components/AgentPanel";
import { WorkflowPanel } from "./components/WorkflowPanel";
import { SidebarResizeHandle } from "./components/SidebarResizeHandle";
import { useDarkMode } from "@common/hooks/useDarkMode";
import { cn } from "@common/lib/utils";

type Tab = "agent" | "workflows";

const SidebarContent: React.FC = () => {
  const { isDarkMode } = useDarkMode();
  const [activeTab, setActiveTab] = useState<Tab>("agent");

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", isDarkMode);
  }, [isDarkMode]);

  return (
    <div className="relative h-screen flex flex-col bg-background border-l border-border/60">
      <SidebarResizeHandle />
      {/* Tab switcher */}
      <div className="flex border-b border-border/50 pl-1.5">
        <button
          onClick={() => setActiveTab("agent")}
          className={cn(
            "flex-1 py-2.5 text-xs font-medium transition-colors",
            "border-b-2 -mb-px",
            activeTab === "agent"
              ? "text-foreground border-primary"
              : "text-muted-foreground border-transparent hover:text-foreground",
          )}
        >
          Agent
        </button>
        <button
          onClick={() => setActiveTab("workflows")}
          className={cn(
            "flex-1 py-2.5 text-xs font-medium transition-colors",
            "border-b-2 -mb-px",
            activeTab === "workflows"
              ? "text-foreground border-primary"
              : "text-muted-foreground border-transparent hover:text-foreground",
          )}
        >
          Workflows
        </button>
      </div>

      {/* Panel content */}
      <div className="flex-1 min-h-0">
        {activeTab === "agent" ? <AgentPanel /> : <WorkflowPanel />}
      </div>
    </div>
  );
};

export const SidebarApp: React.FC = () => (
  <AgentProvider>
    <WorkflowProvider>
      <SidebarContent />
    </WorkflowProvider>
  </AgentProvider>
);
