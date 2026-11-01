import type { BotDto } from "@openedbot/contracts-api";
import { GROUP_MEMBERS_MAX } from "@openedbot/contracts-api";
import { Checkbox } from "@openedbot/browser-ui-kit";
import { BotFace } from "./bot-face";

/**
 * La liste à cocher des membres d'un groupe : partagée par la création et
 * l'édition (`GroupDialog`) et par le formulaire de création intégré au menu
 * d'un bot (`BotGroupsDialog`).
 *
 * Un bot déjà archivé ne s'y propose pas : `bots` est déjà filtré par
 * l'appelant, ce composant ne fait que rendre la liste et le plafond.
 */
export function GroupMembersFields({
  bots,
  memberIds,
  onToggle,
}: {
  bots: BotDto[];
  memberIds: readonly string[];
  onToggle: (botId: string) => void;
}) {
  const atMax = memberIds.length >= GROUP_MEMBERS_MAX;
  return (
    <div className="scrollbar-subtle grid max-h-56 grid-cols-1 gap-0.5 overflow-y-auto rounded-md border border-border p-1.5">
      {bots.map((bot) => {
        const checked = memberIds.includes(bot.id);
        return (
          <label
            key={bot.id}
            className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted has-disabled:opacity-50"
          >
            <Checkbox
              checked={checked}
              disabled={!checked && atMax}
              onCheckedChange={() => onToggle(bot.id)}
            />
            <BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-5" />
            <span className="truncate">{bot.name}</span>
          </label>
        );
      })}
    </div>
  );
}
