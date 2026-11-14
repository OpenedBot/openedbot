import type { ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import { MCP_CONNECTOR_MARKS } from "./mcp-connector-marks";
import { CARD_DESCRIPTION, CARD_TITLE, SETTINGS_PANEL, SETTINGS_SHELL, SETTINGS_SHELL_HEADER } from "./settings/primitives";

/**
 * A connector's row, shared by Réglages › Connecteurs and by a bot's
 * MCP panel: a 32 px square logo, the name, one muted description
 * line, and the gesture on the right. The card, when there is one, is the
 * section's (`McpConnectorSection`).
 */

/** The « Ajouter » / « Connecter » pill: discreet, but a real button. */
export const CONNECTOR_PILL =
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center rounded-full border border-input bg-card px-3 text-xs font-medium text-foreground shadow-[var(--shadow-xs)] outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * A connector's logo. A known mark paints in its colour on a
 * light tile, in both themes (a black mark on a dark background
 * would disappear); an unknown mark takes the initial of its name.
 */
/**
 * A name's initial: its first letter or its first digit. A name that
 * starts with an emoji (« 👁️ Vision ») must not render half of a
 * UTF-16 pair; with no letter at all, the first whole grapheme.
 */
export function connectorInitial(name: string): string {
  const trimmed = name.trim();
  const letter = /[\p{L}\p{N}]/u.exec(trimmed);
  if (letter) return letter[0];
  return Array.from(trimmed)[0] ?? "?";
}

export function McpConnectorLogo({ id, name, className }: { id: string; name: string; className?: string }) {
  const mark = MCP_CONNECTOR_MARKS[id];
  if (!mark) {
    return (
      <span
        aria-hidden
        data-connector-logo="letter"
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold uppercase text-muted-foreground ring-1 ring-border",
          className,
        )}
      >
        {connectorInitial(name)}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      data-connector-logo={id}
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-black/10 dark:ring-white/10", className)}
    >
      <svg viewBox="0 0 24 24" className="size-[18px]" fill={mark.hex} focusable="false">
        <path d={mark.path} />
      </svg>
    </span>
  );
}

export function McpConnectorRow({
  logo,
  name,
  description,
  caption,
  action,
  onOpen,
  openLabel,
}: {
  logo: ReactNode;
  name: string;
  description?: ReactNode;
  /** A short second line, when the state needs an explanation. */
  caption?: ReactNode;
  action?: ReactNode;
  /** The row opens (detail): the name and the description become a button. */
  onOpen?: () => void;
  openLabel?: string;
}) {
  const body = (
    <>
      {logo}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        {description ? <span className="block truncate text-xs text-muted-foreground">{description}</span> : null}
        {caption ? <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{caption}</span> : null}
      </span>
    </>
  );
  return (
    <li data-connector-row="" className="flex min-w-0 items-center gap-3 py-3">
      {onOpen ? (
        <button
          type="button"
          aria-label={openLabel}
          onClick={onOpen}
          className="-mx-1.5 flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg px-1.5 py-1 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-3">{body}</span>
      )}
      {action ? <span className="flex shrink-0 items-center gap-2">{action}</span> : null}
    </li>
  );
}

/** The row grid: one column, two as soon as the `@container` allows it. */
export const CONNECTOR_GRID = "grid grid-cols-1 gap-x-8 @xl:grid-cols-2";

/**
 * The same grid, set inside a card: the rows take the card's
 * margin and a rule separates them, across the full width. On two columns, the
 * first two rows have no rule above them.
 */
export const CONNECTOR_CARD_GRID = cn(
  SETTINGS_PANEL,
  "grid grid-cols-1 overflow-hidden px-4 @xl:grid-cols-2 @xl:gap-x-8",
  "[&>li]:border-t [&>li]:border-border/60 [&>li:first-child]:border-t-0 @xl:[&>li:nth-child(2)]:border-t-0",
);

/**
 * A section, like every settings card (`DESIGN.md` › Bureau › Carte): the
 * title on the tray, then the card set in it, which carries the list on TWO
 * columns as soon as the panel is wide enough. The width is read on the
 * container, not on the window: the same page lives in the settings modal
 * and full page.
 */
export function McpConnectorSection({
  title,
  description,
  action,
  footer,
  children,
  id,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** What is not a row (a note, an error), under the card. */
  footer?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn("@container", SETTINGS_SHELL)}>
      <div className={cn("flex items-start justify-between gap-3", SETTINGS_SHELL_HEADER)}>
        <div className="min-w-0">
          <h3 id={id} className={CARD_TITLE}>{title}</h3>
          {description ? <p className={CARD_DESCRIPTION}>{description}</p> : null}
        </div>
        {action}
      </div>
      <ul className={CONNECTOR_CARD_GRID}>{children}</ul>
      {footer ? <div className="space-y-2 px-1.5 pt-2 pb-0.5">{footer}</div> : null}
    </section>
  );
}
