import type { ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import { COLLAPSE_MOTION } from "./board-chrome";

/** Width of the editor to the right of the thread (16 px gutter included). */
export const EDITOR_SLOT_WIDTH = 356;

/**
 * Like the conversations sidebar, animate only the clipping column's width.
 * Keep the editor mounted at its full width so its controls do not reflow
 * during opening, closing, or a reversal partway through the transition.
 */
export function InlineEditorSlot({ visible, children }: { visible: boolean; children: ReactNode }) {
  return (
    <div
      data-editor-slot={visible ? "open" : "closed"}
      className={cn("min-h-0 shrink-0 overflow-clip transition-[width]", COLLAPSE_MOTION)}
      style={{ width: visible ? EDITOR_SLOT_WIDTH : 0 }}
      aria-hidden={!visible}
      inert={!visible}
    >
      <div className="h-full ps-4" style={{ width: EDITOR_SLOT_WIDTH }}>
        {children}
      </div>
    </div>
  );
}
