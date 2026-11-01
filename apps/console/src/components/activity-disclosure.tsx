import { cn } from "@openedbot/browser-ui-kit";

/**
 * The fold of the Agent Activity feed and of a Tool Result panel, as
 * `disclosure()` in the Stream collection of streaming-ui.pulseview.app:
 * height, opacity, a top-down clip and a 4 px lift, 220 ms to open and
 * 140 ms to close (`agent-activity.css`).
 *
 * The height animates through `grid-template-rows` (1fr / 0fr), never through
 * a measured pixel height: nothing reads the geometry in the commit, which
 * keeps the thread's send budget (OHB-88). A closed fold is `inert`: its
 * controls leave the tab order and the accessibility tree.
 */
export function ActivityDisclosure({
  open,
  id,
  className,
  children,
}: {
  open: boolean;
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id} data-open={open ? "true" : "false"} inert={!open} className={cn("ohb-disclosure", className)}>
      <div className="ohb-disclosure-inner">{children}</div>
    </div>
  );
}
