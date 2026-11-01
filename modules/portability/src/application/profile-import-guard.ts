import { withTenant, type Db, type TransactionDb } from "@openedbot/platform-db";
import {
  assertProfileNamesAvailable as checkNames, assertNoProfileImportReservations as checkAll,
  lockProfileImports,
} from "../sql/reservations";
import { ProfileDeleteError, ProfileImportError } from "../domain/errors";
import { HttpError } from "@openedbot/contracts-errors/http-error";

export { lockProfileImports };
export async function assertProfileNamesAvailable(tx: TransactionDb, organizationId: string, names: readonly string[]): Promise<void> {
  try { await checkNames(tx, organizationId, names); }
  catch (error) { throw asProfileHttpError(error); }
}
export async function assertNoProfileImportReservations(tx: TransactionDb, organizationId: string): Promise<void> {
  try { await checkAll(tx, organizationId); }
  catch (error) { throw asProfileHttpError(error); }
}
export function asProfileHttpError(error: unknown): unknown {
  if (error instanceof ProfileImportError) return new HttpError(error.status, error.code, error.message, {}, error.details);
  if (error instanceof ProfileDeleteError) return new HttpError(error.status, error.code, error.message);
  return error;
}

/** One reserved connection spans the host calls and all short tenant transactions.
 * Reusing it avoids holding a pool slot while trying to acquire another one.
 */
async function withImportSession<T>(db: Db, org: string, callback: (connection: Db) => Promise<T>): Promise<T> {
  const connection = await db.reserve();
  let locked = false;
  let reusable = true;
  try {
    await connection`select pg_advisory_lock(hashtext(${org}), hashtext('hermes-profile-import'))`;
    locked = true;
    // Bun 1.3.14 reserved.begin emits an extra unhandled rejection when its
    // callback throws. Drive transactions on this reserved session directly,
    // and serialize them so concurrent reads cannot overlap BEGIN/COMMIT.
    let tail: Promise<unknown> = Promise.resolve();
    const begin = (fn: (tx: TransactionDb) => Promise<unknown>): Promise<unknown> => {
      const transaction = tail.then(async () => {
        await connection`begin`;
        try {
          const result = await fn(connection as unknown as TransactionDb);
          await connection`commit`;
          return result;
        } catch (error) {
          try { await connection`rollback`; }
          catch { reusable = false; }
          throw error;
        }
      });
      tail = transaction.catch(() => undefined);
      return transaction;
    };
    const scoped = new Proxy(connection, { get(target, key) {
      if (key === "begin") return begin;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    return await callback(scoped);
  } finally {
    if (locked) {
      try { await connection`select pg_advisory_unlock(hashtext(${org}), hashtext('hermes-profile-import'))`; }
      catch { reusable = false; }
    }
    if (reusable) connection.release();
    else await connection.close({ timeout: 0 });
  }
}

export async function withProfileNamesLock<T>(db: Db, org: string, names: readonly string[] | null, callback: (connection: Db) => Promise<T>): Promise<T> {
  return withImportSession(db, org, async (connection) => {
    const conflict = await withTenant(connection, org, async (tx) => {
      try {
        if (names === null) await assertNoProfileImportReservations(tx, org);
        else await assertProfileNamesAvailable(tx, org, names);
        return null;
      } catch (error) { if (error instanceof HttpError) return error; throw error; }
    });
    if (conflict) throw conflict;
    return callback(connection);
  });
}

export async function withBotProfileLock<T>(db: Db, org: string, botId: string, callback: (connection: Db) => Promise<T>): Promise<T> {
  return withImportSession(db, org, async (connection) => {
    const conflict = await withTenant(connection, org, async (tx) => {
      const rows = await tx<Array<{ slug: string; profile: string | null }>>`
        select slug, hermes_profile as "profile" from bots where organization_id = ${org} and id = ${botId}
      `;
      try {
        if (rows[0]) await assertProfileNamesAvailable(tx, org, [rows[0].slug, rows[0].profile].filter((value): value is string => typeof value === "string"));
        return null;
      } catch (error) { if (error instanceof HttpError) return error; throw error; }
    });
    if (conflict) throw conflict;
    return callback(connection);
  });
}
