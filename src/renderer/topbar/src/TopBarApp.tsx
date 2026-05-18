import React from "react";
import { BrowserProvider } from "./contexts/BrowserContext";
import { TabBar } from "./components/TabBar";
import { AddressBar } from "./components/AddressBar";

export const TopBarApp: React.FC = () => {
  return (
    <BrowserProvider>
      <div className="flex flex-col glass select-none">
        {/* Tab Bar */}
        <div className="w-full h-9 pr-2 flex items-center app-region-drag">
          <TabBar />
        </div>

        {/* Toolbar */}
        <div className="flex items-center px-3 py-1.5 gap-2 app-region-drag bg-background/50 dark:bg-background/30 shadow-[0_1px_3px_rgba(0,0,0,0.04)] z-10">
          <AddressBar />
        </div>
      </div>
    </BrowserProvider>
  );
};
