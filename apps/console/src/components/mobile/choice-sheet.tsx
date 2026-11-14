import type { ReactNode } from "react";
import { IconCheck } from "@tabler/icons-react";
import { cn, Dialog } from "@openedbot/browser-ui-kit";
import { InsetGroupedSection, insetGroupedRowClassName } from "./inset-grouped";

/**
 * The iOS selector: a sheet of rows with a check, not a dropdown.
 *
 * A styled `<select>` reads as a web form: frame, chevron, a list
 * that unfolds over the content and closes on the first scroll. iOS
 * never shows that: the setting's row shows its value, one taps it, and
 * a sheet takes the screen with every option, one per row, the check
 * on the current one. It is longer to write and much shorter to use:
 * the target goes from 24 px to 48, and the list really scrolls.
 *
 * Options are GROUPED: « Connectés » before « À connecter »,
 * « Raisonnement » before « Rapide ». A group with no title stays a group.
 */
export type ChoiceOption<T extends string> = {
  id: T;
  label: string;
  /** Second line: what the option commits to, never a repetition of the name. */
  detail?: string;
  /** To the right of the label: a status pill, a capability. */
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
  /** The bottom bar: an action that is not a choice (« Gérer les accès »). */
  footer?: ReactNode;
  /** Above the groups: a search field, a note. */
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
                    <span className="block truncate text-left text-[17px] leading-[22px] text-[var(--openedbot-grouped-label)]">
                      {option.label}
                    </span>
                    {option.detail ? (
                      <span className="mt-0.5 block truncate text-left text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
                        {option.detail}
                      </span>
                    ) : null}
                  </span>
                  {option.trailing ? <span className="shrink-0">{option.trailing}</span> : null}
                  {/* The check replaces the chevron: this row leads
                      nowhere, it IS the value. */}
                  {option.id === value ? (
                    <IconCheck
                      aria-hidden
                      className="size-5 shrink-0 text-[var(--openedbot-grouped-back)]"
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
