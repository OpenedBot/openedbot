import type { Db, TransactionDb } from "@openedbot/platform-db";

/**
 * The pass's queries on its own reserved connection: holding it while
 * waiting for another pool slot could starve the pool. Bun's `reserved.begin`
 * misbehaves when its callback throws (see `profile-import-guard.ts`): the
 * transactions are driven by hand and run one at a time.
 */
export function serialSession(session: Awaited<ReturnType<Db["reserve"]>>, broken: () => void): Db {
  let tail: Promise<unknown> = Promise.resolve();
  const begin = (fn: (tx: TransactionDb) => Promise<unknown>): Promise<unknown> => {
    const transaction = tail.then(async () => {
      await session`begin`;
      try {
        const result = await fn(session as unknown as TransactionDb);
        await session`commit`;
        return result;
      } catch (error) {
        try { await session`rollback`; } catch { broken(); }
        throw error;
      }
    });
    tail = transaction.catch(() => undefined);
    return transaction;
  };
  return new Proxy(session, { get(target, key) {
    if (key === "begin") return begin;
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as unknown as Db;
}

/**
 * `run` under a session advisory lock taken WITHOUT waiting, on a reserved
 * connection that holds nothing else; `null` when another session holds it.
 */
export async function withTryLock<T>(db: Db, organizationId: string, name: string, run: (session: Db) => Promise<T>): Promise<T | null> {
  const session = await db.reserve();
  let reusable = true;
  try {
    const rows = await session<Array<{ got: boolean }>>`select pg_try_advisory_lock(hashtext(${organizationId}), hashtext(${name})) as got`;
    if (!rows[0]?.got) return null;
    try {
      return await run(serialSession(session, () => { reusable = false; }));
    } finally {
      try { await session`select pg_advisory_unlock(hashtext(${organizationId}), hashtext(${name}))`; }
      catch { reusable = false; }
    }
  } finally {
    if (reusable) session.release();
    else await session.close({ timeout: 0 });
  }
}
