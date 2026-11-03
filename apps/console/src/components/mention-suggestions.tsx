import { useEffect, useRef } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import type { MentionableBot } from "@openedbot/roster/domain/mentions";
import { BotFace } from "./bot-face";
import { useT } from "../lib/i18n";

/** L'id DOM d'une option, partagé avec `aria-activedescendant` côté textarea. */
export const mentionOptionId = (listId: string, botId: string) => `${listId}-${botId}`;

/**
 * La liste des bots qu'on peut mentionner, flottante au-dessus du composer.
 *
 * Pas un Popover : le focus doit RESTER dans le textarea (les flèches, Entrée
 * et Échap sont gérés là-bas), et un portail n'apporterait rien à une liste
 * ancrée juste au-dessus de la pilule. `onMouseDown` empêche le clic de
 * voler le focus avant que `onClick` n'ait inséré la mention.
 */
export function MentionSuggestions({
  id,
  left = 0,
  bots,
  activeIndex,
  onHover,
  onPick,
}: {
  id: string;
  /** Offset from the column's left edge, in px: the menu opens at the caret. */
  left?: number;
  bots: MentionableBot[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (bot: MentionableBot) => void;
}) {
  const { t } = useT();
  const list = useRef<HTMLUListElement>(null);

  // Le clavier peut descendre sous le pli de la liste : suivre l'option active.
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
      {bots.map((bot, index) => (
        <li
          key={bot.id}
          id={mentionOptionId(id, bot.id)}
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(bot)}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm",
            index === activeIndex && "bg-background-tertiary-default text-accent-foreground",
          )}
        >
          <BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-5 shrink-0" />
          <span className="truncate">{bot.name}</span>
          <span className="truncate text-muted-foreground">@{bot.slug}</span>
        </li>
      ))}
    </ul>
  );
}
