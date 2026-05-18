import React from "react";
import { LucideIcon } from "lucide-react";
import { cn } from "../../../common/lib/utils";

interface ToolBarButtonProps {
  Icon?: LucideIcon;
  active?: boolean;
  toggled?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
  className?: string;
}

export const ToolBarButton: React.FC<ToolBarButtonProps> = ({
  Icon,
  active = true,
  toggled = false,
  onClick,
  children,
  className,
}) => {
  return (
    <div
      className={cn(
        "size-7 flex items-center justify-center rounded-lg",
        "text-muted-foreground app-region-no-drag",
        "transition-all duration-150",
        !active
          ? "opacity-40"
          : "hover:bg-black/[0.06] dark:hover:bg-white/[0.08] active:scale-95 cursor-pointer",
        toggled && "bg-primary/10 text-primary",
        className,
      )}
      onClick={active ? onClick : undefined}
      tabIndex={-1}
    >
      {children || (Icon && <Icon className="size-4" />)}
    </div>
  );
};
