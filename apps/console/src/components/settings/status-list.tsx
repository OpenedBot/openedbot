import { isValidElement, type ReactNode } from "react";
import { cn, useIsMobile } from "@openedbot/browser-ui-kit";

/**
 * The read-only facts of a settings card: `StatusRow` in a `StatusList`
 * (a `<dl>`), or tiles in a `StatusGrid`. Split out of `primitives.tsx`,
 * which re-exports them: a screen imports them from there as before.
 */
/**
 * Past this length, a value does not fit in the right column
 * of a 430 pt row: it goes under the label rather than being
 * abbreviated there. Measured on the screens' real values (IPs, dates, emails
 * fit; a sentence or a URL does not).
 */
const STATUS_VALUE_MAX = 26;

/**
 * Does the value go down under the label?
 *
 * Only a text is measured. A badge is short by construction, except when it
 * carries a whole sentence (an error message set in a pill): its text is
 * measured then, otherwise the right column's `truncate` cuts it to three
 * words on phone.
 */
function statusValueWraps(value: ReactNode): boolean {
  if (typeof value === "number") return false;
  if (isValidElement<{ children?: ReactNode }>(value)) {
    return statusValueWraps(value.props.children);
  }
  if (typeof value !== "string") return false;
  return value.length > STATUS_VALUE_MAX;
}

/**
 * A row of a status `<dl>`: the label on the left, the value on the right.
 *
 * On phone it is the Settings row: a 17 pt label on the left, the value in
 * grey on the right, 48 pt tall. It STACKED the two (the grid's `sm:`
 * only triggers at 640 px), which gave a column of pairs
 * label/value at 12 px: the geometry of a shrunk desktop table, not
 * that of a list.
 */
export function StatusRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  const isMobile = useIsMobile();
  if (isMobile) {
    const wraps = statusValueWraps(value);
    return (
      <div className={cn("flex min-h-12 gap-3 px-4", wraps ? "flex-col justify-center py-3" : "items-center")}>
        <dt className="shrink-0 text-[17px] leading-[22px] text-[var(--openedbot-grouped-label)]">
          {label}
        </dt>
        <dd
          className={cn(
            "min-w-0 text-[var(--openedbot-grouped-caption)]",
            wraps
              ? "text-[15px] leading-5 break-words"
              : "flex-1 truncate text-right text-[17px] leading-[22px]",
            mono && "font-mono text-[13px]",
          )}
        >
          {value}
        </dd>
      </div>
    );
  }
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words text-xs text-foreground", mono && "font-mono")}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The `<dl>` that carries the `StatusRow`s: hairlines between the rows, no margin.
 *
 * `-mx-4` on phone: the card already sets 16 px of padding, and the rows
 * set another 16. Without that the label started 32 px from the card's
 * edge and the hairline never touched its right edge: two details which, put
 * end to end, no longer look like a system list.
 */
export function StatusList({ children, className }: { children: ReactNode; className?: string }) {
  const isMobile = useIsMobile();
  return (
    <dl
      className={cn(
        isMobile ? "openedbot-status-list -mx-4" : "divide-y divide-border",
        className,
      )}
    >
      {children}
    </dl>
  );
}

/**
 * The « tiles » variant of `StatusList`: the same `<dl>`, set in a grid.
 *
 * A status card often says only short facts: a device, an IP,
 * two dates. In rows, each one eats the card's whole width and leaves
 * three quarters empty; the eye goes down four times to read what fits in
 * two rows. `StatusGrid` sets them side by side. The content does not change,
 * it is the same `<dl>`, the same `<dt>`/`<dd>`, so the same reading for a
 * screen reader.
 *
 * On mobile the geometry falls back to the list: grouped iOS lists are
 * a pattern of the system, not a decoration one replaces with a grid.
 */
export function StatusGrid({
  children,
  columns = 2,
  className,
}: {
  children: ReactNode;
  columns?: 2 | 3;
  className?: string;
}) {
  const isMobile = useIsMobile();
  if (isMobile) return <dl className={cn("openedbot-status-list -mx-4", className)}>{children}</dl>;
  return (
    <dl
      className={cn(
        "grid gap-2",
        columns === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2",
        className,
      )}
    >
      {children}
    </dl>
  );
}

/**
 * A status tile: the label above, the value below.
 *
 * To place in a `StatusGrid`. Off desktop it becomes a `StatusRow` again,
 * so the caller does not have to write the same card twice.
 */
export function StatusTile({
  label,
  value,
  icon,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  mono?: boolean;
}) {
  const isMobile = useIsMobile();
  if (isMobile) return <StatusRow label={label} value={value} mono={mono} />;
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface-sunken px-3 py-2.5">
      <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {icon ? <span className="[&>svg]:size-3.5">{icon}</span> : null}
        {label}
      </dt>
      <dd className={cn("min-w-0 break-words text-sm text-foreground", mono && "font-mono text-xs")}>
        {value}
      </dd>
    </div>
  );
}
