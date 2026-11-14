import type { ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import type { Tone } from "../settings/primitives";

/*
 * BoardUI status vocabulary (template « Dashboard », boardui.com): a filled
 * pill with no border (-800 text on -200 fill in light). Tokens live in `boardui.css`.
 */

const BADGE: Record<Tone, string> = {
  success: "bg-status-lime-background text-status-lime-text",
  warning: "bg-status-yellow-background text-status-yellow-text",
  danger: "bg-status-rose-background text-status-rose-text",
  info: "bg-status-blue-background text-status-blue-text",
  neutral: "bg-status-neutral-background text-status-neutral-text",
};

export function StatusBadge({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[13px] leading-[18px] font-medium [&_svg]:size-3.5 [&_svg]:shrink-0", BADGE[tone], className)}>
    {children}
  </span>;
}
