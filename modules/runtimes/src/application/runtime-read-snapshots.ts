import { logger } from "@openedbot/platform-observability";
import { postgresSnapshotStore } from "../sql/runtime-read-snapshots";

export type RuntimeReadKind = "mcp" | "models" | "profiles" | "integrations";
/** Under this age a snapshot answers without any host read. */
export const SNAPSHOT_FRESH_MS = 60_000;
/** Up to this age a snapshot answers at once while a shared read replaces it. */
export const SNAPSHOT_STALE_MS = 10 * 60_000;
/**
 * A host whose connector watches its inventory (0160) says when it changes:
 * until then its snapshot is right, and re-reading it on every visit only
 * starts interpreters on the host. The hour bounds a lost signal; the day is
 * how long a snapshot of a watched host may still answer at once.
 */
export const WATCHED_SNAPSHOT_FRESH_MS = 60 * 60_000;
export const WATCHED_SNAPSHOT_STALE_MS = 24 * 60 * 60_000;

/**
 * The read policy of a kind the host connector watches (`integrations`,
 * `mcp`): its last signal makes an older snapshot stale, and a watched host
 * keeps its snapshot longer.
 */
export function watchedReadPolicy(inventory: { changedAt: Date | null; watched: boolean } | undefined): Pick<ReadInput<unknown>, "changedAt" | "freshMs" | "staleMs"> {
  if (!inventory) return {};
  return {
    changedAt: inventory.changedAt,
    ...(inventory.watched ? { freshMs: WATCHED_SNAPSHOT_FRESH_MS, staleMs: WATCHED_SNAPSHOT_STALE_MS } : {}),
  };
}

export function wantsFreshRead(query: string | undefined): boolean {
  return query === "1" || query === "true";
}

/**
 * Where snapshots live. `observedAt` is when the live read that produced the
 * document BEGAN; a write observed before the last invalidation, or before
 * the kept document, must change nothing (the PostgreSQL store fences it in
 * the upsert itself, across processes).
 */
export type SnapshotStore = {
  read(organizationId: string, runtimeId: string, kind: RuntimeReadKind): Promise<{ document: unknown; observedAt: Date } | null>;
  write(organizationId: string, runtimeId: string, kind: RuntimeReadKind, document: unknown, observedAt: Date): Promise<void>;
  invalidate(organizationId: string, kind: RuntimeReadKind | undefined, at: Date): Promise<void>;
};

export { postgresSnapshotStore };

export type ReadInput<T> = {
  organizationId: string;
  runtimeId: string;
  kind: RuntimeReadKind;
  /** `?fresh=1`: the answer is always a live read (the proof of a write). */
  fresh?: boolean;
  /** The live host read; it returns the PUBLIC dto, the only thing stored. */
  read: () => Promise<T>;
  /** Only a successful dto is stored (default: every value). */
  keep?: (value: T) => boolean;
  /**
   * A snapshot observed before this instant is treated as absent, and a read
   * in flight that began before it is not joined: the route knows the host
   * changed since (a profile job the worker settled, which cannot invalidate
   * a table it has no access to).
   */
  notOlderThan?: Date | null;
  /**
   * The host said this kind changed at this instant (`inventory.changed`): a
   * snapshot observed before it still answers at once, but is never fresh,
   * so a shared read replaces it.
   */
  changedAt?: Date | null;
  /** Override `SNAPSHOT_FRESH_MS` / `SNAPSHOT_STALE_MS` (see `watchedReadPolicy`). */
  freshMs?: number;
  staleMs?: number;
  now?: () => number;
};

type Flight = { promise: Promise<unknown>; startedAt: number };

// Live reads in flight in this process, one per key; an entry leaves the map
// when its read settles, so the map holds at most one entry per busy key.
const flights = new Map<string, Flight>();
// When a background refresh of a key last logged a failure: at most one line
// a minute per key, forgotten on the next success.
const lastBackgroundError = new Map<string, number>();
const MAX_ERROR_KEYS = 1_000;

function snapshotKey(organizationId: string, runtimeId: string, kind: RuntimeReadKind): string {
  return `${organizationId}\u0000${runtimeId}\u0000${kind}`;
}

export async function readThrough<T>(store: SnapshotStore, input: ReadInput<T>): Promise<T> {
  const key = snapshotKey(input.organizationId, input.runtimeId, input.kind);
  const now = input.now ?? Date.now;
  // A proof read (`fresh`) never joins a read that began before it: another
  // API process may have changed the host in between, which no in-process
  // invalidation saw. Concurrent proof reads still share one.
  const floor = Math.max(input.notOlderThan?.getTime() ?? Number.NEGATIVE_INFINITY, input.fresh ? now() : Number.NEGATIVE_INFINITY);

  const runLive = (): Promise<T> => {
    const existing = flights.get(key);
    if (existing && existing.startedAt >= floor) return existing.promise as Promise<T>;
    const startedAt = now();
    const promise = (async () => {
      const value = await input.read();
      lastBackgroundError.delete(key);
      if (input.keep?.(value) ?? true) {
        try {
          await store.write(input.organizationId, input.runtimeId, input.kind, value, new Date(startedAt));
        } catch {
          // A live public DTO remains useful when snapshot persistence is unavailable.
        }
      }
      return value;
    })();
    const flight: Flight = { promise, startedAt };
    flights.set(key, flight);
    const settle = () => { if (flights.get(key) === flight) flights.delete(key); };
    void promise.then(settle, settle);
    return promise;
  };

  if (input.fresh) return runLive();

  let snapshot: Awaited<ReturnType<SnapshotStore["read"]>> = null;
  try {
    snapshot = await store.read(input.organizationId, input.runtimeId, input.kind);
  } catch {
    return runLive();
  }
  if (!snapshot || snapshot.observedAt.getTime() < floor) return runLive();
  const age = Math.max(0, now() - snapshot.observedAt.getTime());
  const changed = input.changedAt != null && snapshot.observedAt.getTime() < input.changedAt.getTime();
  if (age < (input.freshMs ?? SNAPSHOT_FRESH_MS) && !changed) return snapshot.document as T;
  if (age < (input.staleMs ?? SNAPSHOT_STALE_MS)) {
    runLive().then(
      () => undefined,
      (error: unknown) => {
        const last = lastBackgroundError.get(key);
        if (last === undefined || now() - last >= 60_000) {
          // Bounded: a key of a deleted runtime never succeeds again.
          if (lastBackgroundError.size >= MAX_ERROR_KEYS) lastBackgroundError.delete(lastBackgroundError.keys().next().value!);
          lastBackgroundError.set(key, now());
          logger.warn({ event: "runtime.read_snapshot.refresh_failed", runtimeId: input.runtimeId, kind: input.kind, error: String(error) }, "runtime snapshot background refresh failed");
        }
      },
    );
    return snapshot.document as T;
  }
  return runLive();
}

/**
 * A write changed the host: tombstone the snapshots (the store refuses any
 * write observed before `at`) and stop sharing the reads in flight here, so
 * the next caller, the proof read first, starts a read of its own.
 */
export async function invalidateSnapshots(store: SnapshotStore, organizationId: string, kind?: RuntimeReadKind, now: () => number = Date.now): Promise<void> {
  const prefix = `${organizationId}\u0000`;
  for (const key of [...flights.keys()]) {
    if (key.startsWith(prefix) && (kind === undefined || key.endsWith(`\u0000${kind}`))) flights.delete(key);
  }
  await store.invalidate(organizationId, kind, new Date(now()));
}
