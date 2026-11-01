import type { ThreadView } from "./api";

function mergeRows<T>(retained: readonly T[], preferred: readonly T[], key: (row: T) => string, order: (a: T, b: T) => number): T[] {
  const rows = new Map(retained.map((row) => [key(row), row]));
  for (const row of preferred) rows.set(key(row), row);
  return [...rows.values()].sort(order);
}

function dated(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  const time = (value: string) => value.replace(/\.(\d{3})Z$/, ".$1000Z");
  return time(a.createdAt).localeCompare(time(b.createdAt)) || a.id.localeCompare(b.id);
}

/** Older pages add history; only the latest read may replace live run state. */
export function mergeThreadHistory(current: ThreadView | undefined, incoming: ThreadView, direction: "older" | "latest"): ThreadView {
  if (!current || current.id !== incoming.id) return incoming;
  if (current === incoming) return current;
  const live = direction === "older" || current.cursor > incoming.cursor ? current : incoming;
  const retained = live === current ? incoming : current;
  const keepBoundary = direction === "latest" && (current.historyLoaded || live === current);
  const boundary = keepBoundary ? current.history : incoming.history;
  const turnKeys = [...new Set([...(current.history?.turnKeys ?? []), ...(incoming.history?.turnKeys ?? [])])];
  return {
    ...live,
    messages: mergeRows(retained.messages, live.messages, (row) => row.id, (a, b) => {
      if (a.sequence && b.sequence) {
        const left = BigInt(a.sequence), right = BigInt(b.sequence);
        return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
      }
      return dated(a, b);
    }),
    runs: mergeRows(retained.runs, live.runs, (row) => row.id, dated),
    events: mergeRows(retained.events, live.events, (row) => `${row.runId}:${row.sequence}`, (a, b) => a.cursor - b.cursor),
    workflows: mergeRows(retained.workflows ?? [], live.workflows ?? [], (row) => row.id, dated),
    // L'état du résumé (DEV-332) n'avance ni avec le curseur ni avec les
    // événements : la lecture la plus récente fait foi, même si un flux plus
    // avancé garde le reste du fil.
    compaction: direction === "latest" ? incoming.compaction ?? live.compaction : live.compaction,
    history: boundary ? { ...boundary, turnKeys } : undefined,
    historyLoaded: direction === "older" || current.historyLoaded ? true : undefined,
    truncated: boundary?.hasMore ?? live.truncated,
  };
}

/** Reconnects can span more than one recent page. Fill that gap before retaining an older boundary. */
export async function readThreadHistoryHead(read: (before?: string) => Promise<ThreadView>, current: ThreadView | undefined): Promise<ThreadView> {
  let head = await read();
  if (!current?.historyLoaded || current.id !== head.id || !current.history?.turnKeys.length) return head;
  const known = new Set(current.history.turnKeys);
  const requested = new Set<string>();
  while (head.history?.nextBefore && !head.history.turnKeys.some((key) => known.has(key))) {
    const before = head.history.nextBefore;
    if (requested.has(before)) throw new Error("History cursor did not progress");
    requested.add(before);
    head = mergeThreadHistory(head, await read(before), "older");
  }
  return head;
}
