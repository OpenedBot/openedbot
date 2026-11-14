import { useEffect, useRef } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import { BotFace } from "./bot-face";
import { PluginBadge } from "./plugin-badge";
import { useT } from "../lib/i18n";
import { mentionOptionKey, type MentionOption } from "../lib/composer/mention-options";

/** An option's DOM id, shared with `aria-activedescendant` on the textarea side. */
export const mentionOptionId = (listId: string, option: MentionOption) =>
  `${listId}-${mentionOptionKey(option)}`;

/**
 * The list of bots one can mention, then the connectors one can name, floating above the composer.
 *
 * Not a Popover: focus must STAY in the textarea (the arrows, Enter
 * and Escape are handled there), and a portal would add nothing to a list
 * anchored just above the pill. `onMouseDown` stops the click from
 * stealing focus before `onClick` has inserted the mention.
 */
export function MentionSuggestions({
  id,
  left = 0,
  options,
  activeIndex,
  onHover,
  onPick,
}: {
  id: string;
  /** Offset from the column's left edge, in px: the menu opens at the caret. */
  left?: number;
  options: MentionOption[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (option: MentionOption) => void;
}) {
  const { t } = useT();
  const list = useRef<HTMLUListElement>(null);

  // The keyboard can move below the fold of the list: follow the active option.
  useEffect(() => {
    const active = list.current?.children.item(activeIndex);
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  return (
    <ul
      ref={list}
      id={id}
      role="listbox"
      aria-label={t("composer.mentionListAriaLabel")}
      style={{ left }}
      className="scrollbar-subtle absolute bottom-full z-20 mb-2 max-h-56 w-72 overflow-y-auto rounded-xl border border-border-button-default bg-background-primary-default p-1 text-popover-foreground shadow-dropdown"
    >
      {options.map((option, index) => (
        <li
          key={mentionOptionKey(option)}
          id={mentionOptionId(id, option)}
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(option)}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm",
            index === activeIndex && "bg-background-tertiary-default text-accent-foreground",
          )}
        >
          {option.kind === "bot" ? (
            <>
              <BotFace name={option.bot.name} seed={option.bot.id} face={option.bot.face} className="size-5 shrink-0" />
              <span className="truncate">{option.bot.name}</span>
              <span className="truncate text-muted-foreground">@{option.bot.slug}</span>
            </>
          ) : (
            <>
              <PluginBadge name={option.name} />
              <span className="truncate">{option.name}</span>
              <span className="truncate text-muted-foreground">{t("composer.mentionConnectorLabel")}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
