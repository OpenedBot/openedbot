import type { ComponentProps, ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import { CARD_DESCRIPTION, CARD_TITLE, SETTINGS_INSET, SETTINGS_SHELL, SETTINGS_SHELL_HEADER } from "../settings/primitives";

/**
 * A card of Settings › Activité, in the settings' two layers (`DESIGN.md` ›
 * Bureau › Carte): the title, its sentence and the control (period,
 * granularity) on the tray, the figures, the plot or the table in the card.
 *
 * Not `SettingsTableFrame`: the tray is the `@container/card` the charts'
 * header reads (the period toggles from 767 px), and a silhouette puts a bar
 * where the title goes, so the title is a node, not a string.
 */
export function DashboardCard({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
  ...rest
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Lays out the content inside the card. */
  contentClassName?: string;
} & Omit<ComponentProps<"section">, "children" | "className" | "title">) {
  return (
    <section data-dashboard-card="" className={cn(SETTINGS_SHELL, "@container/card min-w-0", className)} {...rest}>
      <div className={cn("flex flex-wrap items-start justify-between gap-3", SETTINGS_SHELL_HEADER)}>
        <div className="min-w-0">
          <h2 className={CARD_TITLE}>{title}</h2>
          {description ? <div className={CARD_DESCRIPTION}>{description}</div> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <div className={SETTINGS_INSET}>
        <div className={cn("min-w-0", contentClassName)}>{children}</div>
      </div>
    </section>
  );
}

/**
 * The four tiles laid flat in one card: the `gap-px` over a hairline-coloured
 * background draws the separators, whatever the number of columns (1, 2, 4).
 */
export const STAT_GRID = "grid grid-cols-1 gap-px bg-border/60 @xl/main:grid-cols-2 @5xl/main:grid-cols-4";

/**
 * One figure: its label, the value, a badge on the right, two lines under it.
 * The value's line height is fixed (`leading-8`) so the tile keeps its height
 * when the text grows at 250 px, and a silhouette lines up with it.
 */
export function StatTile({
  label,
  value,
  badge,
  footerTitle,
  footerSubtitle,
}: {
  label: ReactNode;
  value: ReactNode;
  badge: ReactNode;
  footerTitle: ReactNode;
  footerSubtitle: ReactNode;
}) {
  return (
    <div data-stat-tile="" className="@container/card flex min-w-0 flex-col gap-3 bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs leading-4 text-muted-foreground">{label}</div>
          <div className="mt-1 text-xl leading-8 font-semibold tabular-nums @[250px]/card:text-2xl">{value}</div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">{badge}</div>
      </div>
      <div className="flex flex-col gap-0.5 text-xs leading-4">
        <div className="line-clamp-1 font-medium">{footerTitle}</div>
        <div className="text-muted-foreground">{footerSubtitle}</div>
      </div>
    </div>
  );
}
