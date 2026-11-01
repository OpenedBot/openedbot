/**
 * Le temps réel d'une réponse, tel que le fil le connaît déjà : le run porte
 * sa création, sa fin et ses jetons, ses `agent.message` leur heure.
 *
 * Origine : la création du run, c'est-à-dire l'instant où l'API a accepté le
 * message (quelques millisecondes après le clic). « Premier jeton » est le
 * premier morceau de texte produit par le modèle, « Total » la fin du run.
 */
export type RunTiming = {
  firstTokenMs: number | null;
  totalMs: number;
  /** Jetons de sortie (raisonnement compris) par seconde du run entier, `null` sans usage. */
  tokensPerSecond: number | null;
  /** Nombre de morceaux de texte reçus du modèle. */
  chunks: number;
};

type TimedRun = {
  id: string;
  createdAt?: string;
  endedAt?: string | null;
  usage?: { outputTokens?: number } | null;
};

type TimedEvent = {
  runId: string;
  type: string;
  occurredAt: Date | string;
};

const at = (value: Date | string): number => new Date(value).getTime();

/** Les runs terminés seulement : un run en cours n'a pas encore de durée. */
export function runTimings(
  runs: readonly TimedRun[],
  events: readonly TimedEvent[],
  runIds?: ReadonlySet<string>,
  eventsByRun?: ReadonlyMap<string, readonly TimedEvent[]>,
  runsById?: ReadonlyMap<string, TimedRun>,
): Map<string, RunTiming> {
  const firstText = new Map<string, number>();
  const chunks = new Map<string, number>();
  const addTextEvent = (event: TimedEvent) => {
    if (event.type !== "agent.message") return;
    const time = at(event.occurredAt);
    const known = firstText.get(event.runId);
    if (known === undefined || time < known) firstText.set(event.runId, time);
    chunks.set(event.runId, (chunks.get(event.runId) ?? 0) + 1);
  };
  if (runIds && eventsByRun) {
    for (const runId of runIds) {
      for (const event of eventsByRun.get(runId) ?? []) addTextEvent(event);
    }
  } else {
    for (const event of events) {
      if (runIds && !runIds.has(event.runId)) continue;
      addTextEvent(event);
    }
  }
  const timings = new Map<string, RunTiming>();
  const addRunTiming = (run: TimedRun) => {
    if (!run.createdAt || !run.endedAt) return;
    const start = at(run.createdAt);
    const end = at(run.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
    const first = firstText.get(run.id);
    // Sur la durée totale, comme assistant-ui : les jetons de sortie comptent
    // aussi le raisonnement, produit AVANT le premier texte visible. Les
    // diviser par la seule phase d'écriture gonflait la vitesse.
    const totalMs = end - start;
    const output = run.usage?.outputTokens ?? 0;
    timings.set(run.id, {
      firstTokenMs: first !== undefined ? Math.max(0, first - start) : null,
      totalMs,
      tokensPerSecond: output > 0 && totalMs > 0 ? output / (totalMs / 1000) : null,
      chunks: chunks.get(run.id) ?? 0,
    });
  };
  if (runIds && runsById) {
    for (const runId of runIds) {
      const run = runsById.get(runId);
      if (run) addRunTiming(run);
    }
  } else {
    for (const run of runs) {
      if (runIds && !runIds.has(run.id)) continue;
      addRunTiming(run);
    }
  }
  return timings;
}

/** « 4.03s » : la forme courte, sous la bulle et dans le détail. */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}
