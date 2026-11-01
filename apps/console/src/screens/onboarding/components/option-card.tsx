import { cn } from "@openedbot/browser-ui-kit";
import { ObInput } from "@openedbot/browser-ui-kit/components/onboarding";
import { useT } from "../../../lib/i18n";

const OTHER_INPUT_MAX_LENGTH = 80;

/**
 * La rangée-option éditoriale, style radio.
 *
 * Référence de dessin : le `.opt` du bloc onboarding(3) : un liséré fin au
 * repos et, une fois choisie : anneau intérieur plein + marqueur radio devenu
 * point. Toute la rangée est la cible de clic.
 */
export function OptionCard({
  selected,
  onSelect,
  label,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "group flex w-full items-center gap-3.5 rounded-lg border bg-card px-4 py-2.5 text-left transition-all",
        selected
          ? "border-foreground shadow-[inset_0_0_0_1px_var(--color-foreground)]"
          : "hover:border-foreground/20 hover:bg-accent/30",
      )}
    >
      <RadioMark selected={selected} />
      <span className="text-body font-normal leading-tight text-foreground">{label}</span>
    </button>
  );
}

/**
 * La variante « Autre » : révèle un champ de 80 caractères sous la rangée une
 * fois choisie. Le focus automatique à la première ouverture épargne un clic.
 */
export function OtherOptionCard({
  selected,
  onSelect,
  otherValue,
  onOtherChange,
  placeholder,
}: {
  selected: boolean;
  onSelect: () => void;
  otherValue: string;
  onOtherChange: (value: string) => void;
  placeholder: string;
}) {
  const { t } = useT();
  return (
    <div
      className={cn(
        "flex w-full flex-col rounded-lg border bg-card transition-all",
        selected
          ? "border-foreground shadow-[inset_0_0_0_1px_var(--color-foreground)]"
          : "hover:border-foreground/20",
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        className="flex w-full items-center gap-3.5 px-4 py-2.5 text-left"
      >
        <RadioMark selected={selected} />
        <span className="text-body font-normal leading-tight text-foreground">
          {t("onboarding.option_card.other_label")}
        </span>
      </button>
      {selected && (
        <div className="px-4 pb-3 pl-[44px]">
          <ObInput
            autoFocus
            type="text"
            value={otherValue}
            onChange={(event) => onOtherChange(event.target.value)}
            placeholder={placeholder}
            maxLength={OTHER_INPUT_MAX_LENGTH}
            className="h-8 rounded-none border-x-0 border-t-0 border-b px-0 text-body shadow-none focus-visible:border-foreground focus-visible:ring-0"
            aria-label={placeholder}
          />
        </div>
      )}
    </div>
  );
}

export function RadioMark({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-block h-4 w-4 shrink-0 rounded-full border-[1.5px] transition-colors",
        selected ? "border-foreground" : "border-border",
      )}
    >
      {selected && <span className="absolute inset-[3px] rounded-full bg-foreground" />}
    </span>
  );
}

export { OTHER_INPUT_MAX_LENGTH };
