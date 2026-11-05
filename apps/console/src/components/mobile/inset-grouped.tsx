import type { ComponentProps, ComponentType, ReactNode } from "react";
import { IconCheck, IconChevronLeft, IconChevronRight, IconX } from "@tabler/icons-react";
import { cn } from "@openedbot/browser-ui-kit";

/**
 * Inset Grouped : le language PWA (voir `apps/console/DESIGN.md`).
 * Cartes 20 px sans stroke, filets inset, icônes outline monochromes.
 */

export const insetGroupedRowClassName =
  "openedbot-press relative flex min-h-12 w-full items-center gap-3 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** Le chevron « ‹ » de la barre de nav iOS : bleu système, pas une pastille ghost. */
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
   * Le pied du groupe : la phrase qui explique ce que la liste engage.
   *
   * Une liste groupée iOS porte son explication SOUS la carte, pas dans une
   * ligne : la phrase n'est pas un réglage, elle ne se tape pas, et la mettre
   * dans le groupe lui donnerait une cible de 44 pt qui ne mène nulle part.
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
   * `value` sous le libellé, sur autant de lignes qu'il faut, au lieu de la
   * colonne droite tronquée à 42 % : pour une phrase, pas pour un réglage.
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
 * Ligne lecture seule : même géométrie, pas un bouton.
 *
 * `multiline` : la valeur est une phrase, elle passe sous le libellé et
 * n'est jamais tronquée.
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
 * Barre d'actions iOS (`.bottomBar`) : dernier enfant d'une colonne
 * `overflow: hidden`, **jamais** `position: fixed` (Safari décroche au clavier,
 * même contrat que le composer).
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
 * Nav-bar iOS : LE CHEVRON SEUL, 44 pt, bleu système, pas de pilule.
 *
 * Jamais « ‹ Retour ». Le mot posait ~84 px de bleu à gauche face à une
 * colonne de droite de 44 : le titre `flex-1 text-center` se centrait entre
 * les deux, donc à l'écran il tombait à droite du centre. Les deux colonnes
 * latérales font maintenant la même largeur, et le titre est centré pour de
 * bon. Le nom de la destination vit dans `aria-label`, pas à l'écran.
 */
export function InsetBackButton({
  label,
  onClick,
  className,
}: {
  /** Le nom de la destination : annoncé par le lecteur d'écran, jamais peint. */
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
 * Le contrôle segmenté iOS : `UISegmentedControl`, pas des onglets web.
 *
 * Trois à quatre destinations sœurs sur un écran racine : une pilule par
 * segment sur un lit gris, celle qui est active remonte en blanc. Ce n'est pas
 * une barre d'onglets (elle vivrait en bas) et ce n'est pas un `Button ghost`
 * souligné : ces deux-là se lisent comme du web dès qu'on les touche.
 *
 * Extrait de l'écran Connecteurs, qui en portait l'unique copie.
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
  /** `count` déjà formaté par l'appelant : c'est lui qui connaît sa locale. */
  segments: ReadonlyArray<{ id: T; label: string; count?: string | null }>;
  /** Nom accessible de la rangée. */
  label: string;
  /** `id` du panneau que la rangée pilote (`aria-controls`). */
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
