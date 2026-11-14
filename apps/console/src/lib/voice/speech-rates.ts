/**
 * The reading speed chosen per bot in the agent editor, read at
 * speak time. A registry rather than a thread prop: one more prop
 * in the `ThreadTimeline` context would empty its turn cache on every
 * roster patch.
 */
const rates = new Map<string, number>();

export function registerSpeechRates(entries: Iterable<readonly [string, number | undefined]>): void {
  rates.clear();
  for (const [botId, rate] of entries) if (rate && rate !== 1) rates.set(botId, rate);
}

export function speechRateFor(botId: string | null | undefined): number {
  return (botId && rates.get(botId)) || 1;
}
