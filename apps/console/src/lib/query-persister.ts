import { experimental_createQueryPersister, type AsyncStorage, type PersistedQuery } from "@tanstack/query-persist-client-core";
import { clear, createStore, del, get, set } from "idb-keyval";
import { hashKey, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { clearAppAccessHint } from "./session/app-access-hint";
import { clearBootIdentity } from "./session/boot-identity";
import { readCloudSession } from "./session/cloud-session";

/**
 * After a refresh the in-memory cache is empty, so the conversation waited for
 * the network before painting a single message. The roster and the threads are
 * now kept in IndexedDB: the screen paints the last known state at once, and
 * TanStack refetches it right after (`refetchOnRestore`, the default 10 s
 * `staleTime` makes any restored entry stale).
 *
 * Only those two keys are written: a thread is the first paint, the roster
 * names its thread. Session, guards, secrets, health and anything polled stay
 * network only. Entries are scoped to the signed-in user (storage key prefix)
 * and to the organization (the query key itself), expire after a day, and are
 * busted by every build. Sign out and a lost or replaced session wipe the
 * store (`clearPersistedQueries`).
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Injected by `vite.config.ts` (`define`); absent under `bun test`.
declare const __OHB_BUILD_ID__: string | undefined;
const BUILD_ID = typeof __OHB_BUILD_ID__ === "string" ? __OHB_BUILD_ID__ : "dev";

const store = typeof indexedDB === "undefined" ? null : createStore("ohb-query-cache", "queries");

function userScope(): string | null {
  return readCloudSession()?.userId ?? null;
}

/** Bumped by every purge: a read started before it belongs to the wiped session. */
let purgeGeneration = 0;

/**
 * The identity a read started under. IndexedDB answers asynchronously: a read
 * begun for account A can resolve after sign out, the purge, and account B's
 * sign in. Its value must then be dropped, never put back in the emptied cache.
 */
export function capturePersistedReadScope(): { stillCurrent(): boolean } {
  const user = userScope();
  const generation = purgeGeneration;
  return { stillCurrent: () => generation === purgeGeneration && user === userScope() };
}

const storage: AsyncStorage<string> = {
  getItem: async (key) => {
    const user = userScope();
    if (!store || !user) return undefined;
    const scope = capturePersistedReadScope();
    const value = await get<string>(`${user}:${key}`, store);
    return scope.stillCurrent() ? value : undefined;
  },
  setItem: async (key, value) => {
    const user = userScope();
    if (store && user) await set(`${user}:${key}`, value, store).catch(() => undefined);
  },
  removeItem: async (key) => {
    const user = userScope();
    if (store && user) await del(`${user}:${key}`, store).catch(() => undefined);
  },
};

export function isPersistedQueryKey(queryKey: QueryKey): boolean {
  if (queryKey[0] !== "organization") return false;
  return queryKey.at(-1) === "roster" || queryKey.at(-2) === "thread";
}

/**
 * Data read back from IndexedDB, until the network replaces it. A restored
 * thread is shown, never trusted: its SSE cursor may be hours old and its
 * pages may miss turns written since, so the thread query does not merge into
 * it and the stream waits for the fresh snapshot (`use-thread-stream.ts`).
 */
const restored = new WeakSet<object>();

export function isRestoredQueryData(data: unknown): boolean {
  return typeof data === "object" && data !== null && restored.has(data);
}

const persister = experimental_createQueryPersister<string>({
  storage,
  maxAge: MAX_AGE_MS,
  buster: BUILD_ID,
  filters: { predicate: (query: Query) => isPersistedQueryKey(query.queryKey) },
  deserialize: (value) => {
    const persisted = JSON.parse(value) as PersistedQuery;
    const data = persisted.state.data;
    if (typeof data === "object" && data !== null) restored.add(data);
    return persisted;
  },
});

export const persistQueryFn = persister.persisterFn;

/**
 * Installs a persisted entry in the cache NOW, before the first render, instead
 * of on the query's first fetch. Restored on fetch, the roster and the thread
 * each landed in their own task after the frame had painted its skeletons:
 * a refresh showed the silhouette, then the skeleton frame, then a blank
 * thread, then the data. The entry is marked invalidated, so its first
 * observer still refetches it, whatever its age.
 */
export async function restorePersistedQuery(client: QueryClient, queryKey: QueryKey): Promise<unknown> {
  if (!isPersistedQueryKey(queryKey)) return undefined;
  const cached = client.getQueryData(queryKey);
  if (cached !== undefined) return cached;
  const scope = capturePersistedReadScope();
  const data = await persister.retrieveQuery(hashKey(queryKey));
  if (!scope.stillCurrent()) return undefined;
  // A network answer arrived meanwhile: it wins.
  if (data === undefined || client.getQueryData(queryKey) !== undefined) return client.getQueryData(queryKey);
  client.setQueryData(queryKey, data);
  void client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
  return data;
}

export async function clearPersistedQueries(): Promise<void> {
  purgeGeneration += 1;
  clearAppAccessHint();
  clearBootIdentity();
  if (store) await clear(store).catch(() => undefined);
}
