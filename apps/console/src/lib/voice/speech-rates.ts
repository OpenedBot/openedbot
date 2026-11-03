/**
 * La vitesse de lecture choisie par bot dans l'éditeur d'agent, lue au
 * moment de parler. Un registre plutôt qu'une prop du fil : une prop de plus
 * dans le contexte de `ThreadTimeline` viderait son cache de tours à chaque
 * patch du roster.
 */
const rates = new Map<string, number>();

export function registerSpeechRates(entries: Iterable<readonly [string, number | undefined]>): void {
  rates.clear();
  for (const [botId, rate] of entries) if (rate && rate !== 1) rates.set(botId, rate);
}

export function speechRateFor(botId: string | null | undefined): number {
  return (botId && rates.get(botId)) || 1;
}
