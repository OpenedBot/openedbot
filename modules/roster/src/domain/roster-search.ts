import type { BotDto, GroupDto } from "@openedbot/contracts-api";

type SearchableBot = Pick<BotDto, "name" | "slug" | "description" | "preview">;
type SearchableGroup = Pick<GroupDto, "name" | "preview" | "members">;

/**
 * Canonical form shared by every roster surface. NFKD makes a query typed
 * without accents match a display name that contains them, while the token
 * split lets words match different metadata fields.
 */
export function normalizeRosterQuery(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function matchesRosterFields(fields: Array<string | null | undefined>, tokens: string[]): boolean {
  if (tokens.length === 0) return true;

  const normalizedFields = fields.map((field) => normalizeRosterQuery(field ?? "").join(" "));
  return tokens.every((token) => normalizedFields.some((field) => field.includes(token)));
}

export function filterRosterBots<T extends SearchableBot>(bots: readonly T[], query: string): T[] {
  const tokens = normalizeRosterQuery(query);
  if (tokens.length === 0) return [...bots];

  return bots.filter((bot) =>
    matchesRosterFields([bot.name, bot.slug, bot.description, bot.preview], tokens),
  );
}

export function filterRosterGroups<T extends SearchableGroup>(
  groups: readonly T[],
  query: string,
): T[] {
  const tokens = normalizeRosterQuery(query);
  if (tokens.length === 0) return [...groups];

  return groups.filter((group) =>
    matchesRosterFields(
      [
        group.name,
        group.preview,
        ...group.members.flatMap((member) => [member.name, member.slug]),
      ],
      tokens,
    ),
  );
}
