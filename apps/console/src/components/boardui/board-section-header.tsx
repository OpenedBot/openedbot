import { RiArrowRightSLine } from "@remixicon/react";
import { cn } from "@openedbot/browser-ui-kit";

/**
 * A list heading on desktop, the reference app's section header
 * (`sectionHeader`): 30 px, margins 8 / 8 / 6, 13/18 grey text, normal
 * weight, aligned with the row text (8 px).
 */
export const SECTION_LABEL_DENSE = "flex h-[30px] shrink-0 items-center px-2 pt-2 pb-1.5 text-[13px] leading-[18px] font-normal text-text-section-label";

/** Folder header: click to collapse. The mouse hover is the same step as the tiles. */
export function BoardSectionHeader({
  label,
  collapsed,
  count,
  onToggle,
  onPointerDown,
  dense = false,
}: {
  label: string;
  collapsed: boolean;
  count: number;
  onToggle: () => void;
  /** Dragging the header reorders the sections; absent for « Non assigné ». */
  onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
  dense?: boolean;
}) {
  if (dense) {
    // Desktop: the mockup's heading, always collapsible. The chevron follows
    // the name instead of preceding it, so the name stays aligned with the
    // rows; it stays visible (dimmed), full on hover, on focus or when collapsed.
    return (
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        onPointerDown={onPointerDown}
        className={cn(SECTION_LABEL_DENSE, "group w-full min-w-0 cursor-pointer gap-0.5 rounded-lg outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring")}
      >
        <span className="min-w-0 truncate text-left">{label}</span>
        <RiArrowRightSLine
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-[transform,opacity]",
            collapsed ? "opacity-100" : "rotate-90 opacity-60 group-hover:opacity-100 group-focus-visible:opacity-100",
          )}
        />
        {collapsed ? <span className="ms-auto tabular-nums">{count}</span> : null}
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      onPointerDown={onPointerDown}
      className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-1 rounded-xl px-2 text-body-2-medium text-text-tertiary outline-none hover:bg-background-tertiary-hover hover:text-text-secondary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
    >
      <RiArrowRightSLine className={cn("size-4 shrink-0 transition-transform", !collapsed && "rotate-90")} />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {collapsed ? <span className="tabular-nums">{count}</span> : null}
    </button>
  );
}
