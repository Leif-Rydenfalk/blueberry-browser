import React, { useCallback, useRef, useState } from "react";
import { cn } from "@common/lib/utils";

const MIN_WIDTH = 280;
const MAX_WIDTH = 900;

// Thin draggable strip pinned to the LEFT edge of the sidebar. The user drags
// it to widen/narrow the panel. We use screenX (absolute, not viewport-relative)
// for the delta math so the cursor's reported X doesn't shift when the WebContents
// view's bounds change mid-drag.
export const SidebarResizeHandle: React.FC = () => {
  const [isDragging, setIsDragging] = useState(false);
  const dragStateRef = useRef<{
    startScreenX: number;
    startWidth: number;
    pending: number | null;
    rafId: number | null;
  } | null>(null);

  const flush = useCallback(() => {
    const state = dragStateRef.current;
    if (!state || state.pending === null) return;
    const width = state.pending;
    state.pending = null;
    state.rafId = null;
    void window.sidebarAPI.setSidebarWidth(width);
  }, []);

  const schedule = useCallback(
    (width: number) => {
      const state = dragStateRef.current;
      if (!state) return;
      state.pending = width;
      if (state.rafId === null) {
        state.rafId = requestAnimationFrame(flush);
      }
    },
    [flush],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      // Cursor moved LEFT relative to drag start → widen sidebar.
      const delta = state.startScreenX - event.screenX;
      const next = Math.min(
        Math.max(state.startWidth + delta, MIN_WIDTH),
        MAX_WIDTH,
      );
      schedule(next);
    },
    [schedule],
  );

  const endDrag = useCallback(() => {
    const state = dragStateRef.current;
    if (state && state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      // Apply any final pending width synchronously so the release lands true.
      if (state.pending !== null) {
        void window.sidebarAPI.setSidebarWidth(state.pending);
      }
    }
    dragStateRef.current = null;
    setIsDragging(false);
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
  }, [handlePointerMove]);

  const handlePointerDown = useCallback(
    async (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startWidth =
        (await window.sidebarAPI.getSidebarWidth().catch(() => 400)) || 400;
      dragStateRef.current = {
        startScreenX: event.screenX,
        startWidth,
        pending: null,
        rafId: null,
      };
      setIsDragging(true);
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", endDrag);
      window.addEventListener("pointercancel", endDrag);
    },
    [endDrag, handlePointerMove],
  );

  return (
    <div
      onPointerDown={handlePointerDown}
      className={cn(
        "absolute left-0 top-0 bottom-0 w-1.5 z-50",
        "cursor-col-resize select-none",
        "transition-colors",
        isDragging ? "bg-primary/40" : "bg-transparent hover:bg-primary/20",
      )}
      title="Drag to resize sidebar"
    >
      {/* Inner hairline gives a subtle visible cue without taking layout space */}
      <div
        className={cn(
          "absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-px",
          isDragging
            ? "bg-primary/60"
            : "bg-border/0 group-hover:bg-border/60",
        )}
      />
    </div>
  );
};
