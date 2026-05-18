import React, { useState, useEffect } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  Loader2,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
import { useBrowser } from "../contexts/BrowserContext";
import { ToolBarButton } from "../components/ToolBarButton";
import { Favicon } from "../components/Favicon";
import { DarkModeToggle } from "../components/DarkModeToggle";
import { cn } from "@common/lib/utils";

export const AddressBar: React.FC = () => {
  const { activeTab, navigateToUrl, goBack, goForward, reload, isLoading } =
    useBrowser();
  const [url, setUrl] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  useEffect(() => {
    if (activeTab && !isEditing) setUrl(activeTab.url || "");
  }, [activeTab, isEditing]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    let finalUrl = url.trim();
    if (!finalUrl.startsWith("http://") && !finalUrl.startsWith("https://")) {
      if (finalUrl.includes(".") && !finalUrl.includes(" ")) {
        finalUrl = `https://${finalUrl}`;
      } else {
        finalUrl = `https://www.google.com/search?q=${encodeURIComponent(finalUrl)}`;
      }
    }
    navigateToUrl(finalUrl);
    setIsEditing(false);
    setIsFocused(false);
    (document.activeElement as HTMLElement)?.blur();
  };

  const handleFocus = () => {
    setIsEditing(true);
    setIsFocused(true);
  };
  const handleBlur = () => {
    setIsEditing(false);
    setIsFocused(false);
    if (activeTab) setUrl(activeTab.url || "");
  };

  const getDomain = () => {
    if (!activeTab?.url) return "";
    try {
      return new URL(activeTab.url).hostname.replace("www.", "");
    } catch {
      return activeTab.url;
    }
  };

  const getFavicon = () => {
    if (!activeTab?.url) return null;
    try {
      return `https://www.google.com/s2/favicons?domain=${new URL(activeTab.url).hostname}&sz=32`;
    } catch {
      return null;
    }
  };

  const toggleSidebar = () => {
    setIsSidebarOpen(!isSidebarOpen);
    window.topBarAPI?.toggleSidebar();
  };

  const canGoBack = activeTab !== null;
  const canGoForward = activeTab !== null;

  return (
    <>
      {/* Navigation Controls */}
      <div className="flex gap-0.5 app-region-no-drag">
        <ToolBarButton
          Icon={ArrowLeft}
          onClick={goBack}
          active={canGoBack && !isLoading}
        />
        <ToolBarButton
          Icon={ArrowRight}
          onClick={goForward}
          active={canGoForward && !isLoading}
        />
        <ToolBarButton
          onClick={reload}
          active={activeTab !== null && !isLoading}
        >
          {isLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
        </ToolBarButton>
      </div>

      {/* Address Bar */}
      {isFocused ? (
        <form
          onSubmit={handleSubmit}
          className="flex-1 min-w-0 max-w-full app-region-no-drag"
        >
          <div className="bg-background rounded-xl shadow-md ring-1 ring-primary/20 p-1">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onFocus={handleFocus}
              onBlur={handleBlur}
              className="w-full px-3 py-1.5 text-sm outline-none bg-transparent text-foreground rounded-lg"
              placeholder={activeTab ? "Enter URL or search" : "No active tab"}
              disabled={!activeTab}
              spellCheck={false}
              autoFocus
            />
          </div>
        </form>
      ) : (
        <div
          onClick={handleFocus}
          className={cn(
            "flex-1 px-3 h-8 rounded-full cursor-text app-region-no-drag",
            "bg-secondary/80 dark:bg-secondary/40 hover:bg-secondary",
            "transition-all duration-200 flex items-center gap-2",
            "border border-transparent hover:border-border/50",
          )}
        >
          {isLoading ? (
            <span className="text-base animate-pulse">🫐</span>
          ) : (
            <Favicon src={getFavicon()} className="size-3.5" />
          )}
          <span className="text-xs text-muted-foreground truncate flex-1">
            {activeTab ? (
              getDomain()
            ) : (
              <span className="italic">No active tab</span>
            )}
          </span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-0.5 app-region-no-drag">
        <DarkModeToggle />
        <ToolBarButton
          Icon={isSidebarOpen ? PanelLeftClose : PanelLeft}
          onClick={toggleSidebar}
          toggled={isSidebarOpen}
        />
      </div>
    </>
  );
};
