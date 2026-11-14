import type { BotDto } from "@openedbot/contracts-api";
import { GROUP_MEMBERS_MAX } from "@openedbot/contracts-api";
import { Checkbox } from "@openedbot/browser-ui-kit";
import { BotFace } from "./bot-face";

/**
 * The checkbox list of a group's members, in a group's editing
 * (`GroupDialog`). Creation goes through `/g/new` (« À : »).
 *
 * An already archived bot is not offered there: `bots` is already filtered by
 * the caller, this component only renders the list and the ceiling.
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
