import type { ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";

/**
 * Le contrôle segmenté des réglages : une piste en creux, l'option retenue
 * posée dessus (`DESIGN.md` › Bureau › Regrouper et aligner). Pour un choix
 * exclusif court, à droite d'une ligne, à la place d'une rangée de boutons
 * bordés ou de boutons radio.
 */
const TRACK = "inline-flex shrink-0 flex-wrap gap-0.5 rounded-lg bg-background-secondary-default p-0.5";
const OPTION = "rounded-md px-3 py-1 text-sm outline-none transition-colors";
const SELECTED = "bg-background-primary-default font-medium text-foreground shadow-sm dark:bg-accent";

/** Des boutons `aria-pressed` : le choix s'applique au clic (Apparence). */
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
 * Les mêmes segments en vrais boutons radio, pour un champ de formulaire
 * enregistré plus tard (plafond des agents) : le `<input type="radio">` reste
 * natif (clavier, `fieldset disabled`, lecteur d'écran), seulement masqué.
 * À poser dans un `<fieldset>` qui porte la `<legend>`.
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
 * Un champ de formulaire en ligne : libellé et phrase à gauche, la commande à
 * droite, comme `ListRow`. `legend` reste la vraie légende du `fieldset`.
 */
export function FieldsetRow({ legend, hint, disabled, children }: { legend: string; hint?: ReactNode; disabled?: boolean; children: ReactNode }) {
  return (
    <fieldset disabled={disabled} className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <legend className="sr-only">{legend}</legend>
      <div className="min-w-0 flex-1 basis-48">
        {/* Le texte visible de la légende, déjà lue par le `<legend>`. */}
        <p aria-hidden className="text-sm font-medium">{legend}</p>
        {hint ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="ml-auto">{children}</div>
    </fieldset>
  );
}
