/**
 * The bot model (or effort) saves still on their way to the server, per bot,
 * whichever `ThreadModelPicker` started them: the composer chip, the header
 * pill or the bot page. A send waits for them (a few milliseconds) so the run
 * leaves with the model just chosen, even when it was chosen on a page that
 * is already closed. Nothing renders from here: a plain map, not a store.
 */
const pending = new Map<string, Set<Promise<void>>>();

/** Records one save; it leaves the map on its own once settled. */
export function trackBotModelSave(botId: string, save: Promise<void>): void {
  const saves = pending.get(botId) ?? new Set<Promise<void>>();
  saves.add(save);
  pending.set(botId, saves);
  const forget = () => {
    saves.delete(save);
    if (saves.size === 0 && pending.get(botId) === saves) pending.delete(botId);
  };
  save.then(forget, forget);
}

/** Resolves once every save of this bot started so far has settled (a failed save does not block a send). */
export async function settledBotModelSaves(botId: string | undefined): Promise<void> {
  if (!botId) return;
  const saves = pending.get(botId);
  if (!saves || saves.size === 0) return;
  await Promise.allSettled(saves);
}
