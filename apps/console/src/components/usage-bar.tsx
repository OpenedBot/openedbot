import { cn } from "@openedbot/browser-ui-kit";

/**
 * Usage gauge of a measured provider.
 *
 * The tint carries the information: graphite at rest, amber then red when the
 * wall approaches; the brand blue stays reserved for actions. A usage
 * that cannot be read has no gauge at all: an empty track would read as
 * « zéro consommé », and a dotted rule reads as a separator.
 */
export function UsageBar({
  value,
  label,
  className,
}: {
  value: number;
  label: string;
  className?: string;
}) {
  const safe = Math.max(0, Math.min(100, value));
  const tone = safe > 95 ? "bg-destructive" : safe > 80 ? "bg-amber-500" : "bg-foreground/70";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(safe)}
      aria-valuetext={label}
      className={cn("h-1.5 min-w-0 overflow-hidden rounded-full bg-foreground/10", className)}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none", tone)}
        style={{ width: `${safe}%` }}
      />
    </div>
  );
}
