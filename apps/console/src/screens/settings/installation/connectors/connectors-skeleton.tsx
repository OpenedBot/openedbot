import { cn } from "@openedbot/browser-ui-kit";
import { SETTINGS_SHELL, SETTINGS_SHELL_HEADER } from "../../../../components/settings/primitives";
import { CONNECTOR_CARD_GRID } from "../../../../components/mcp-connector-row";

const BAR = "animate-pulse rounded bg-muted motion-reduce:animate-none";

/** A connector line: logo, name, description, action pill. */
function RowSkeleton() {
  return (
    <li aria-hidden className="flex min-w-0 items-center gap-3 py-3">
      <span className={cn(BAR, "size-8 shrink-0 rounded-lg")} />
      <span className="min-w-0 flex-1 space-y-1.5">
        <span className={cn(BAR, "block h-3.5 w-24")} />
        <span className={cn(BAR, "block h-3 w-48 max-w-full")} />
      </span>
      <span className={cn(BAR, "h-7 w-16 shrink-0 rounded-full")} />
    </li>
  );
}

/**
 * A section like `McpConnectorSection`: the title on the tray, then the
 * card of rows set in it, on two columns as soon as the container allows it.
 */
function SectionSkeleton({ rows }: { rows: number }) {
  return (
    <div className={cn("@container", SETTINGS_SHELL)}>
      <div className={SETTINGS_SHELL_HEADER}>
        <div className={cn(BAR, "h-4 w-28")} />
      </div>
      <ul className={CONNECTOR_CARD_GRID}>
        {Array.from({ length: rows }, (_, index) => <RowSkeleton key={index} />)}
      </ul>
    </div>
  );
}

/**
 * The Connectors skeleton on desktop during the first read: the same
 * frame as `ConnectorsDesktop` (tabs, search, « Nouveau
 * connecteur », row sections), so nothing jumps when
 * the inventory arrives. Three large empty cards announced another page.
 */
export function ConnectorsDesktopSkeleton({ label }: { label: string }) {
  return (
    <div data-connectors-layout="desktop-skeleton" className="space-y-6" role="status" aria-label={label}>
      <div aria-hidden className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          {["w-28", "w-28", "w-16"].map((width, index) => (
            <span key={index} className={cn(BAR, "h-9 rounded-full", width)} />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <span className={cn(BAR, "h-9 w-full max-w-64 rounded-full")} />
          <span className={cn(BAR, "h-9 w-44 shrink-0 rounded-full")} />
        </div>
      </div>
      <div aria-hidden className="space-y-8">
        <SectionSkeleton rows={1} />
        <SectionSkeleton rows={4} />
        <SectionSkeleton rows={2} />
      </div>
    </div>
  );
}
