import { QueryClient, replaceEqualDeep } from "@tanstack/react-query";
import { isUnauthorized, isWorkspaceChanged } from "./api";
import { isRestoredQueryData, persistQueryFn } from "./query-persister";

/**
 * A 401 is not retried: the response will not change without a new token, and
 * the second try would only delay the « Se connecter » step.
 * `WORKSPACE_CHANGED` neither: the new try would reread the space that became
 * active and store its response under the old key. The rest keeps its
 * single retry.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return !isUnauthorized(error) && !isWorkspaceChanged(error) && failureCount < 1;
}

const localPatches = new WeakSet<object>();

/**
 * Marks a value built by PATCHING the cached one (the thread stream,
 * `useThreadStream`): it already shares the old one's structure, object by
 * object. Default structural sharing would copy it container by
 * container (a new events array per patch) and break what
 * relies on its identity: the event-key index and the recognition
 * of an append at the tail (`eventsAppendedFrom`), both of which avoid
 * walking the thread again on each patch.
 */
export function asLocalPatch<T extends object>(data: T): T {
  localPatches.add(data);
  return data;
}

/**
 * The app's TanStack Query singleton. The route guard deposits
 * `GET /api/auth/me` there; the account card (`account-menu.tsx`) and the other observers read this cache.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The cloud API is on loopback: a request costs a millisecond, but
      // a refetch on focus would flicker a thread that is streaming.
      refetchOnWindowFocus: false,
      retry: shouldRetryQuery,
      // A second observer after the route guard must not refetch.
      staleTime: 10_000,
      // Roster and threads only survive a refresh (`lib/query-persister.ts`);
      // every other key passes straight through.
      persister: persistQueryFn,
      // The first network read after a restore must hand out a new object even
      // when nothing changed: that reference is what tells the thread its
      // snapshot is live and lets the stream start. A local patch
      // (`asLocalPatch`) already shares the cached structure: kept as is.
      structuralSharing: (previous, next) => (
        isRestoredQueryData(previous) || (typeof next === "object" && next !== null && localPatches.has(next))
          ? next
          : replaceEqualDeep(previous, next)
      ),
    },
  },
});

export const DEFAULT_INVALIDATE_DELAY_MS = 250;

type TimerHandle = ReturnType<typeof setTimeout>;

export type InvalidateScheduler = {
  /**
   * Schedules ONE invalidation of `queryKey` within `delayMs`. Calls that
   * follow for the same key during that delay are absorbed: they do not
   * push the deadline back, otherwise a stream that emits every 50 ms
   * would push the reread back until the end of the run.
   */
  schedule(queryKey: readonly unknown[], delayMs?: number): void;
  /** Number of keys pending: for tests and diagnostics. */
  pending(): number;
};

/**
 * Factory of the coalescer, split from the singleton so it is testable without
 * a real clock: tests provide their own timers.
 */
export function createInvalidateScheduler(deps: {
  invalidate: (queryKey: readonly unknown[]) => void;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
}): InvalidateScheduler {
  const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const timers = new Map<string, TimerHandle>();
  return {
    schedule(queryKey, delayMs = DEFAULT_INVALIDATE_DELAY_MS) {
      const id = JSON.stringify(queryKey);
      if (timers.has(id)) return;
      timers.set(id, setTimer(() => {
        timers.delete(id);
        deps.invalidate(queryKey);
      }, delayMs));
    },
    pending() {
      return timers.size;
    },
  };
}

const streamInvalidations = createInvalidateScheduler({
  // `cancelRefetch: false`: a reread already in flight stays valid. Restarting
  // it on every event (the default behavior) cancelled the previous request
  // and started over: hence the burst of `GET /api/bots` that a
  // single streaming run was enough to trigger.
  invalidate: (queryKey) => {
    void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
  },
});

/**
 * Coalesced invalidation, for what the SSE stream triggers.
 *
 * The user's mutations (send, approval, rename) keep their
 * immediate `invalidateQueries`: they arrive one at a time and the response
 * must be seen at once. The stream, though, delivers dozens of events
 * per second during a generation: one reread per event shows
 * nothing more than one reread per quarter second.
 */
export function scheduleInvalidate(queryKey: readonly unknown[], delayMs = DEFAULT_INVALIDATE_DELAY_MS): void {
  streamInvalidations.schedule(queryKey, delayMs);
}
