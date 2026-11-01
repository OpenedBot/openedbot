import type { ReactNode } from "react";
import { IconCheck } from "@tabler/icons-react";
import { cn, Dialog } from "@openedbot/browser-ui-kit";
import { InsetGroupedSection, insetGroupedRowClassName } from "./inset-grouped";

/**
 * Le sélecteur iOS : une feuille de lignes à coche, pas un menu déroulant.
 *
 * Un `<select>` stylé se lit comme un formulaire web : cadre, chevron, liste
 * qui se déplie par-dessus le contenu et se ferme au premier scroll. iOS
 * n'affiche jamais ça : la ligne du réglage montre sa valeur, on la touche, et
 * une feuille prend l'écran avec toutes les options, une par ligne, la coche
 * sur celle en cours. C'est plus long à écrire et bien plus court à utiliser :
 * la cible passe de 24 px à 48, et la liste défile pour de vrai.
 *
 * Les options sont GROUPÉES : « Connectés » avant « À connecter »,
 * « Raisonnement » avant « Rapide ». Un groupe sans titre reste un groupe.
 */
export type ChoiceOption<T extends string> = {
  id: T;
  label: string;
  /** Deuxième ligne : ce que l'option engage, jamais une répétition du nom. */
  detail?: string;
  /** À droite du libellé : une pastille d'état, une capacité. */
  trailing?: ReactNode;
  disabled?: boolean;
};

export type ChoiceGroup<T extends string> = {
  caption?: string;
  footer?: ReactNode;
  options: ReadonlyArray<ChoiceOption<T>>;
};

export function MobileChoiceSheet<T extends string>({
  open,
  title,
  description,
  groups,
  value,
  onSelect,
  onClose,
  closeLabel,
  footer,
  header,
}: {
  open: boolean;
  title: string;
  description?: string;
  groups: ReadonlyArray<ChoiceGroup<T>>;
  value: T | null;
  onSelect: (id: T) => void;
  onClose: () => void;
  closeLabel: string;
  /** La barre du bas : une action qui n'est pas un choix (« Gérer les accès »). */
  footer?: ReactNode;
  /** Au-dessus des groupes : un champ de recherche, une note. */
  header?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      closeLabel={closeLabel}
      bodyClassName="px-0 py-0"
      footer={footer}
    >
      {header}
      <div className="pb-4">
        {groups.map((group, index) => (
          <InsetGroupedSection
            key={group.caption ?? index}
            caption={group.caption}
            footer={group.footer}
            className={index === 0 && !group.caption ? "pt-2" : undefined}
          >
            {group.options.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={option.id === value}
                  disabled={option.disabled}
                  aria-disabled={option.disabled || undefined}
                  onClick={() => {
                    onSelect(option.id);
                    onClose();
                  }}
                  className={cn(
                    insetGroupedRowClassName,
                    option.disabled && "pointer-events-none opacity-45",
                  )}
                  data-inset-grouped-row=""
                >
                  <span className="min-w-0 flex-1 py-3">
                    <span className="block truncate text-left text-[17px] leading-[22px] text-[var(--ohb-grouped-label)]">
                      {option.label}
                    </span>
                    {option.detail ? (
                      <span className="mt-0.5 block truncate text-left text-[13px] leading-4 text-[var(--ohb-grouped-caption)]">
                        {option.detail}
                      </span>
                    ) : null}
                  </span>
                  {option.trailing ? <span className="shrink-0">{option.trailing}</span> : null}
                  {/* La coche remplace le chevron : cette ligne ne mène nulle
                      part, elle EST la valeur. */}
                  {option.id === value ? (
                    <IconCheck
                      aria-hidden
                      className="size-5 shrink-0 text-[var(--ohb-grouped-back)]"
                      stroke={2.25}
                    />
                  ) : null}
                </button>
              </li>
            ))}
          </InsetGroupedSection>
        ))}
      </div>
    </Dialog>
  );
}
