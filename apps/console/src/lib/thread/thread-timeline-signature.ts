import type { Entry } from "./thread-timeline-model";

/** The instant that dates an entry's day chip: its own for a user message, its run's otherwise. */
export function entryDayIso(entry: Entry, turnTimeByRun: ReadonlyMap<string, string>): string | undefined {
  const owner = entryRunId(entry);
  return entry.kind === "user" ? entry.createdAt : owner ? turnTimeByRun.get(owner) : undefined;
}

/**
 * The `runId` carried by an entry, whatever its kind (`event` keeps it
 * under `event.runId`, `gate` under `approval.runId`). Serves both the
 * node cache below and the computation of the "settled" turn.
 */
export function entryRunId(entry: Entry): string | null {
  switch (entry.kind) {
    case "event":
      return entry.event.runId;
    case "gate":
      return entry.approval.runId ?? null;
    default:
      return entry.runId;
  }
}

/**
 * VALUE signature of an entry, all of its own fields, generic `JSON`
 * rather than a hand-written sort: safer against a forgotten field
 * than a manual list, and far less costly than rebuilding the React
 * node (markdown, memoized children) that it avoids (see `turnNodeCache`
 * in `ThreadTimelineView`).
 *
 * Memoized per entry: the incremental model returns the SAME objects for
 * unchanged blocks, and an entry is no longer modified once rendered.
 */
const entrySignatures = new WeakMap<Entry, string>();
export function entrySignature(entry: Entry): string {
  let signature = entrySignatures.get(entry);
  if (signature === undefined) {
    signature = JSON.stringify(entry);
    entrySignatures.set(entry, signature);
  }
  return signature;
}

/** What an author changes in a turn's render: identity, name, slug, face. */
export function authorRenderKey(author: { id: string; name?: string | null; slug?: string | null; face?: unknown } | null | undefined): string {
  return author ? `${author.id}:${author.name ?? ""}:${author.slug ?? ""}:${JSON.stringify(author.face ?? null)}` : "";
}
