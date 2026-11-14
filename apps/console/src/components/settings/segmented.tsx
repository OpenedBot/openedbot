import type { ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";

/**
 * The settings segmented control: a recessed track, the chosen option
 * set on it (`DESIGN.md` › Bureau › Regrouper et aligner). For a short
 * exclusive choice, to the right of a row, in place of a row of bordered
 * buttons or radio buttons.
 */
const TRACK = "inline-flex shrink-0 flex-wrap gap-0.5 rounded-lg bg-background-secondary-default p-0.5";
const OPTION = "rounded-md px-3 py-1 text-sm outline-none transition-colors";
const SELECTED = "bg-background-primary-default font-medium text-foreground shadow-sm dark:bg-accent";

/** `aria-pressed` buttons: the choice applies on click (Appearance). */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  numeric = false,
}: {
  label: string;
  options: ReadonlyArray<{ id: T; label: string; data?: Record<`data-${string}`, string | number> }>;
  value: T;
  onChange: (next: T) => void;
  numeric?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className={TRACK}>
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.id)}
            {...option.data}
            className={cn(
              OPTION,
              "focus-visible:ring-2 focus-visible:ring-ring",
              numeric && "tabular-nums",
              selected ? SELECTED : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The same segments as real radio buttons, for a form field
 * saved later (the agents' ceiling): the `<input type="radio">` stays
 * native (keyboard, `fieldset disabled`, screen reader), only hidden.
 * To place in a `<fieldset>` that carries the `<legend>`.
 */
export function SegmentedRadio<T extends string | null>({
  name,
  options,
  value,
  onChange,
}: {
  name: string;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className={TRACK}>
      {options.map((option) => (
        <label
          key={option.value ?? "none"}
          className={cn(
            OPTION,
            "cursor-pointer text-muted-foreground hover:text-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
            option.value === value && SELECTED,
          )}
        >
          <input
            type="radio"
            name={name}
            className="sr-only"
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

/**
 * An inline form field: label and sentence on the left, the control on
 * the right, like `ListRow`. `legend` stays the `fieldset`'s real legend.
 */
export function FieldsetRow({ legend, hint, disabled, children }: { legend: string; hint?: ReactNode; disabled?: boolean; children: ReactNode }) {
  return (
    <fieldset disabled={disabled} className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <legend className="sr-only">{legend}</legend>
      <div className="min-w-0 flex-1 basis-48">
        {/* The legend's visible text, already read by the `<legend>`. */}
        <p aria-hidden className="text-sm font-medium">{legend}</p>
        {hint ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="ml-auto">{children}</div>
    </fieldset>
  );
}
