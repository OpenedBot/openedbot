import type { ComponentProps, ComponentType, ReactNode } from "react";
import { IconCheck, IconChevronLeft, IconChevronRight, IconX } from "@tabler/icons-react";
import { cn } from "@openedbot/browser-ui-kit";

/**
 * Inset Grouped: the PWA language (see `apps/console/DESIGN.md`).
 * 20 px cards with no stroke, inset hairlines, monochrome outline icons.
 */

export const insetGroupedRowClassName =
  "openedbot-press relative flex min-h-12 w-full items-center gap-3 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** The iOS nav bar's « ‹ » chevron: system blue, not a ghost pill. */
export const insetBackClassName =
  "relative flex size-11 shrink-0 items-center justify-center text-[var(--openedbot-grouped-back)] outline-none focus-visible:ring-2 focus-visible:ring-ring";

type InsetIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

export function InsetGroupedSection({
  caption,
  footer,
  children,
  className,
}: {
  caption?: string;
  /**
   * The group's footer: the sentence that explains what the list commits to.
   *
   * An iOS grouped list carries its explanation UNDER the card, not in a
   * row: the sentence is not a setting, it is not tapped, and putting it
   * in the group would give it a 44 pt target that leads nowhere.
   */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section data-inset-grouped="" className={cn("px-4 pt-4", className)}>
      {caption ? (
        <h2 className="px-4 pb-2 text-[13px] leading-4 font-normal text-[var(--openedbot-grouped-caption)]">
          {caption}
        </h2>
      ) : null}
      <ul className="overflow-hidden rounded-[20px] bg-[var(--openedbot-grouped-card)]">{children}</ul>
      {footer ? (
        <p className="px-4 pt-2 text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">{footer}</p>
      ) : null}
    </section>
  );
}

export function InsetGroupedRowInner({
  icon: Icon,
  label,
  value,
  subtitle,
  chevron = true,
  selected = false,
  disabled = false,
  wrap = false,
}: {
  icon?: InsetIcon;
  label: string;
  value?: string;
  subtitle?: string;
  chevron?: boolean;
  selected?: boolean;
  disabled?: boolean;
  /**
   * `value` under the label, on as many lines as it needs, instead of the
   * right column truncated at 42%: for a sentence, not for a setting.
   */
  wrap?: boolean;
}) {
  const tone = disabled ? "text-[var(--openedbot-grouped-caption)]" : "text-[var(--openedbot-grouped-label)]";
  return (
    <>
      {Icon ? (
        <Icon aria-hidden className={cn("size-[22px] shrink-0 stroke-[1.5]", tone)} />
      ) : null}
      <span className="min-w-0 flex-1 py-3">
        <span className={cn("block truncate text-[17px] leading-[22px]", tone)}>{label}</span>
        {subtitle ? (
          <span className="mt-0.5 block truncate text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
            {subtitle}
          </span>
        ) : null}
        {wrap && value ? (
          <span className="mt-0.5 block whitespace-normal break-words text-[15px] leading-5 text-[var(--openedbot-grouped-caption)]">
            {value}
          </span>
        ) : null}
      </span>
      {!wrap && value ? (
        <span className="max-w-[42%] shrink-0 truncate text-right text-[17px] leading-[22px] text-[var(--openedbot-grouped-caption)]">
          {value}
        </span>
      ) : null}
      {selected ? (
        <IconCheck aria-hidden className="size-5 shrink-0 text-[var(--openedbot-grouped-back)]" stroke={2} />
      ) : chevron && !disabled ? (
        <IconChevronRight
          aria-hidden
          className="size-5 shrink-0 text-[var(--openedbot-grouped-chevron)]"
        />
      ) : null}
    </>
  );
}

export function InsetGroupedRow({
  icon,
  label,
  value,
  subtitle,
  chevron = true,
  selected = false,
  className,
  disabled,
  ...props
}: {
  icon?: InsetIcon;
  label: string;
  value?: string;
  subtitle?: string;
  chevron?: boolean;
  selected?: boolean;
  className?: string;
} & Omit<ComponentProps<"button">, "children">) {
  return (
    <li>
      <button
        type="button"
        data-inset-grouped-row=""
        aria-pressed={selected || undefined}
        {...props}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        className={cn(insetGroupedRowClassName, disabled && "pointer-events-none", className)}
      >
        <InsetGroupedRowInner
          icon={icon}
          label={label}
          value={value}
          subtitle={subtitle}
          chevron={chevron}
          selected={selected}
          disabled={disabled}
        />
      </button>
    </li>
  );
}

/**
 * Read-only row: same geometry, not a button.
 *
 * `multiline`: the value is a sentence, it goes under the label and
 * is never truncated.
 */
export function InsetGroupedStatic({
  icon,
  label,
  value,
  subtitle,
  multiline = false,
}: {
  icon?: InsetIcon;
  label: string;
  value?: string;
  subtitle?: string;
  multiline?: boolean;
}) {
  return (
    <li>
      <div data-inset-grouped-row="" className={insetGroupedRowClassName}>
        <InsetGroupedRowInner
          icon={icon}
          label={label}
          value={value}
          subtitle={subtitle}
          chevron={false}
          wrap={multiline}
        />
      </div>
    </li>
  );
}

export function InsetCloseButton({
  label,
  onClick,
  className,
}: {
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      data-inset-close=""
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--openedbot-grouped-close)] text-[var(--openedbot-grouped-label)] outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <IconX aria-hidden className="size-4" stroke={2.25} />
    </button>
  );
}

/**
 * iOS action bar (`.bottomBar`): last child of a column
 * `overflow: hidden`, **never** `position: fixed` (Safari detaches at the keyboard,
 * the same contract as the composer).
 */
export function MobileActionFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <footer
      data-mobile-action-footer=""
      className={cn(
        "shrink-0 bg-[var(--openedbot-grouped-canvas)] px-4 pt-2 pb-[max(0.75rem,var(--openedbot-safe-bottom))]",
        className,
      )}
    >
      <div className="flex w-full items-stretch gap-2">{children}</div>
    </footer>
  );
}

/**
 * iOS nav bar: THE CHEVRON ALONE, 44 pt, system blue, no pill.
 *
 * Never « ‹ Retour ». The word put ~84 px of blue on the left against a
 * right column of 44: the title `flex-1 text-center` centred between
 * the two, so on screen it fell to the right of centre. The two side
 * columns are now the same width, and the title is centred for
 * good. The destination's name lives in `aria-label`, not on screen.
 */
export function InsetBackButton({
  label,
  onClick,
  className,
}: {
  /** The destination's name: announced by the screen reader, never painted. */
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      data-inset-back=""
      className={cn(insetBackClassName, className)}
    >
      <IconChevronLeft aria-hidden className="size-7" stroke={2} />
    </button>
  );
}

/**
 * The iOS segmented control: `UISegmentedControl`, not web tabs.
 *
 * Three to four sibling destinations on a root screen: one pill per
 * segment on a grey track, the active one comes up in white. It is not
 * a tab bar (that would live at the bottom) and it is not an underlined `Button ghost`:
 * those two read as web as soon as one touches them.
 *
 * Extracted from the Connectors screen, which carried the only copy.
 */
export function MobileSegmented<T extends string>({
  value,
  onChange,
  segments,
  label,
  controls,
  idPrefix,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  /** `count` already formatted by the caller: it is the one that knows its locale. */
  segments: ReadonlyArray<{ id: T; label: string; count?: string | null }>;
  /** The row's accessible name. */
  label: string;
  /** `id` of the panel the row drives (`aria-controls`). */
  controls?: string;
  idPrefix: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      data-mobile-segmented=""
      className={cn("grid rounded-[9px] bg-[var(--openedbot-grouped-close)] p-0.5", className)}
      style={{ gridTemplateColumns: `repeat(${segments.length}, minmax(0, 1fr))` }}
    >
      {segments.map((segment) => {
        const selected = segment.id === value;
        return (
          <button
            key={segment.id}
            type="button"
            role="tab"
            id={`${idPrefix}-${segment.id}`}
            aria-selected={selected}
            aria-controls={controls}
            className={cn(
              "openedbot-press relative min-h-11 truncate rounded-[7px] px-2 text-[13px] leading-4 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              selected
                ? "bg-[var(--openedbot-grouped-card)] text-[var(--openedbot-grouped-label)]"
                : "text-[var(--openedbot-grouped-caption)]",
            )}
            onClick={() => onChange(segment.id)}
          >
            {segment.label}
            {segment.count !== null && segment.count !== undefined ? ` ${segment.count}` : ""}
          </button>
        );
      })}
    </div>
  );
}
