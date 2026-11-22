/**
 * What a refresh of a conversation draws before any read answers: the bot's
 * name (header pill, « Message … » in the composer) and the mark of its model
 * (the composer's model button), remembered per bot so the HTML silhouette of
 * `index.html` (it reads the same key, keep the two in step) and the React
 * stand-ins show the real composer at once instead of grey blocks.
 *
 * `glyph` is the markup this console rendered for the model button
 * (`ModelHeaderGlyph`), replayed as is by the silhouette. Scoped to the user
 * it was recorded for; sign out and a lost session clear it with the
 * persisted queries (`query-persister.ts`).
 */
export const BOOT_BOTS_KEY = "openedbot:boot-bots";

const MAX_BOTS = 30;
const MAX_NAME = 80;
const MAX_GLYPH = 4_000;

export type BootBot = { name: string; glyph?: string; provider?: string | null };
type Stored = { userId: string; bots: Record<string, BootBot & { at: number }> };

function read(userId: string | undefined): Stored | null {
  if (!userId) return null;
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(BOOT_BOTS_KEY) ?? "null") as Partial<Stored> | null;
    if (!parsed || parsed.userId !== userId || typeof parsed.bots !== "object" || parsed.bots === null) return null;
    return { userId, bots: parsed.bots };
  } catch {
    return null;
  }
}

export function readBootBot(userId: string | undefined, botId: string | undefined): BootBot | null {
  if (!botId) return null;
  const bot = read(userId)?.bots[botId];
  return bot && typeof bot.name === "string" && bot.name ? bot : null;
}

/** Merges `patch` into what is remembered for `botId`; writes only on a change. */
export function rememberBootBot(userId: string | undefined, botId: string, patch: Partial<BootBot>): void {
  if (!userId) return;
  try {
    const stored = read(userId) ?? { userId, bots: {} };
    const previous = stored.bots[botId];
    const next = {
      name: (patch.name ?? previous?.name ?? "").slice(0, MAX_NAME),
      glyph: patch.glyph !== undefined ? patch.glyph.slice(0, MAX_GLYPH) : previous?.glyph,
      provider: patch.provider !== undefined ? patch.provider : previous?.provider,
    };
    if (!next.name) return;
    if (previous && previous.name === next.name && previous.glyph === next.glyph && previous.provider === next.provider) return;
    const bots = { ...stored.bots, [botId]: { ...next, at: Date.now() } };
    // The most recent visits only: a long roster does not grow the key forever.
    const kept = Object.entries(bots).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_BOTS);
    globalThis.localStorage?.setItem(BOOT_BOTS_KEY, JSON.stringify({ userId, bots: Object.fromEntries(kept) }));
  } catch {
    // Private mode or quota: the next refresh draws the composer without the name.
  }
}

export function clearBootBots(): void {
  try {
    globalThis.localStorage?.removeItem(BOOT_BOTS_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The bot id of a `/bot/:id` path (internal or `/o/<slug>/...`). */
export function botIdOfPath(pathname: string): string | undefined {
  const match = /\/bot\/([^/]+)\/?$/u.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}
