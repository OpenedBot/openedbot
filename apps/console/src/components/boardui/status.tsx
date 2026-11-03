import type { ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import type { Tone } from "../settings/primitives";

/*
 * BoardUI status vocabulary (template « Dashboard », boardui.com): a filled
 * pill with no border (-800 text on -200 fill in light), a dot with a soft
 * halo, and the chart palette for bars. Tokens live in `boardui.css`.
 */

const BADGE: Record<Tone, string> = {
  success: "bg-status-lime-background text-status-lime-text",
  warning: "bg-status-yellow-background text-status-yellow-text",
  danger: "bg-status-rose-background text-status-rose-text",
  info: "bg-status-blue-background text-status-blue-text",
  neutral: "bg-status-neutral-background text-status-neutral-text",
};

const DOT: Record<Tone, string> = {
  success: "bg-green-500 ring-status-dot-green-halo",
  warning: "bg-yellow-500 ring-status-dot-yellow-halo",
  danger: "bg-rose-500 ring-status-dot-rose-halo",
  info: "bg-blue-500 ring-status-blue-background",
  neutral: "bg-foreground-icon-quaternary ring-transparent",
};

/** Bar fills: lime for what works, pink for failures, yellow to watch, sky for in-flight. */
export const CHART_FILL: Record<Tone, string> = {
  success: "bg-chart-lime",
  warning: "bg-chart-yellow",
  danger: "bg-chart-pink",
  info: "bg-chart-sky",
  neutral: "bg-chart-track",
};

export function StatusBadge({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[13px] leading-[18px] font-medium [&_svg]:size-3.5 [&_svg]:shrink-0", BADGE[tone], className)}>
    {children}
  </span>;
}

export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cn("size-2 shrink-0 rounded-full ring-[3px]", DOT[tone], className)} />;
}
