import React from "react";
import { Plus, X } from "lucide-react";
import { useBrowser } from "../contexts/BrowserContext";
import { Favicon } from "../components/Favicon";
import { TabBarButton } from "../components/TabBarButton";
import { cn } from "@common/lib/utils";

const isMac = window.topBarAPI?.platform === "darwin";

interface TabItemProps {
  id: string;
  title: string;
  favicon?: string | null;
  isActive: boolean;
  onClose: () => void;
  onActivate: () => void;
}

const TabItem: React.FC<TabItemProps> = ({
  title,
  favicon,
  isActive,
  onClose,
  onActivate,
}) => {
  return (
    <div className="flex-1 min-w-[80px] max-w-[200px] py-1 px-0.5">
      <div
        className={cn(
          "group/tab relative flex items-center w-full h-7 pl-2.5 pr-1.5 select-none rounded-lg gap-1.5",
          "text-sm transition-all duration-200 cursor-pointer app-region-no-drag",
          isActive
            ? "bg-background shadow-sm text-foreground font-medium ring-1 ring-border/50"
            : "bg-transparent hover:bg-black/[0.04] dark:hover:bg-white/[0.06] text-muted-foreground",
        )}
        onClick={() => !isActive && onActivate()}
      >
        <Favicon src={favicon} className="size-3.5 flex-shrink-0" />
        <span className="flex-1 min-w-0 text-xs truncate leading-none">
          {title || "New Tab"}
        </span>
        <div
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            "flex-shrink-0 p-0.5 rounded-md transition-all",
            "hover:bg-black/10 dark:hover:bg-white/10",
            "opacity-0 group-hover/tab:opacity-100",
            isActive && "opacity-60 hover:opacity-100",
          )}
        >
          <X className="size-3" />
        </div>
      </div>
    </div>
  );
};

export const TabBar: React.FC = () => {
  const { tabs, createTab, closeTab, switchTab } = useBrowser();

  const handleCreateTab = () => createTab("https://www.google.com");

  const getFavicon = (url: string) => {
    try {
      const domain = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    } catch {
      return null;
    }
  };

  return (
    <div className="flex-1 overflow-x-hidden flex items-center">
      {/* macOS traffic lights OR blueberry logo */}
      {isMac ? (
        <div className="pl-[88px]" />
      ) : (
        <div className="pl-3 pr-2 flex items-center app-region-no-drag">
          <span className="text-base" title="Blueberry Browser">
            🫐
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex-1 overflow-x-auto flex no-scrollbar">
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            id={tab.id}
            title={tab.title}
            favicon={getFavicon(tab.url)}
            isActive={tab.isActive}
            onClose={() => closeTab(tab.id)}
            onActivate={() => switchTab(tab.id)}
          />
        ))}
      </div>

      {/* Add Tab Button */}
      <div className="pl-1 pr-2">
        <TabBarButton Icon={Plus} onClick={handleCreateTab} />
      </div>
    </div>
  );
};
