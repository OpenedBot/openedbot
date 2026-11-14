import type { Db, TransactionDb } from "@openedbot/platform-db";
import type { TenantDeletionRow } from "./deletions";

export type AccountClosureRow = TenantDeletionRow & { userId: string; organizationIds: string[] };
export async function readClosure(tx: TransactionDb, userId: string, lock = false): Promise<AccountClosureRow | null> {
  const rows = lock
    ? await tx<AccountClosureRow[]>`select user_id as "userId", organization_ids as "organizationIds",
        'account_deleted' as reason, requested_at as "requestedAt", purge_after as "purgeAfter", started_at as "startedAt"
        from account_deletions where user_id = ${userId} for update`
    : await tx<AccountClosureRow[]>`select user_id as "userId", organization_ids as "organizationIds",
        'account_deleted' as reason, requested_at as "requestedAt", purge_after as "purgeAfter", started_at as "startedAt"
        from account_deletions where user_id = ${userId}`;
  return rows[0] ?? null;
}
export async function listClosureMemberships(tx: TransactionDb, userId: string): Promise<Array<{ id: string }>> {
  return tx<Array<{ id: string }>>`select organization_id as id from memberships
    where user_id = ${userId} and revoked_at is null order by organization_id`;
}
export async function readClosureOrganization(tx: TransactionDb, id: string, userId: string) {
  const rows = await tx<Array<{ id: string; name: string; role: string; members: number; otherOwners: number }>>`
    select o.id, o.name, m.role,
      (select count(*)::int from memberships other where other.organization_id = o.id and other.revoked_at is null) as members,
      (select count(*)::int from memberships other where other.organization_id = o.id and other.revoked_at is null
        and other.role = 'owner' and other.user_id <> ${userId}) as "otherOwners"
    from organizations o join memberships m on m.organization_id = o.id
    where o.id = ${id} and m.user_id = ${userId} and m.revoked_at is null`;
  return rows[0] ?? null;
}
export async function lockClosureUser(tx: TransactionDb, userId: string): Promise<void> {
  await tx`select id from users where id = ${userId} for update`;
}
export async function insertClosure(tx: TransactionDb, userId: string, organizationIds: string[], graceDays: number): Promise<void> {
  await tx`insert into account_deletions (user_id, organization_ids, purge_after)
    values (${userId}, ${organizationIds}::uuid[], now() + (${graceDays} * interval '1 day'))
    on conflict (user_id) do nothing`;
}
export async function deleteClosure(tx: TransactionDb, userId: string): Promise<void> {
  await tx`delete from account_deletions where user_id = ${userId}`;
}
export async function pendingAccountClosure(db: Db, userId: string): Promise<boolean> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.authenticating_user_id', ${userId}, true)`;
    return Boolean(await readClosure(tx, userId));
  }) as Promise<boolean>;
}
export async function nextClosure(db: Db): Promise<{ userId: string } | null> {
  const rows = await db<Array<{ userId: string }>>`select user_id as "userId" from account_deletions
    where purge_after <= now() and (last_attempt_at is null or last_attempt_at < now() - interval '1 minute')
    order by last_attempt_at asc nulls first, requested_at limit 1`;
  return rows[0] ?? null;
}
export async function recordClosureAttempt(db: Db, userId: string, error: string | null): Promise<void> {
  await db`update account_deletions set last_attempt_at = now(), last_error = ${error} where user_id = ${userId}`;
}
export async function finalizeClosure(tx: TransactionDb, userId: string): Promise<boolean> {
  const rows = await tx<Array<{ done: boolean }>>`select public.finalize_account_closure(${userId}::uuid) as done`;
  return rows[0]?.done === true;
}
export async function hasClosureForTenant(tx: TransactionDb, organizationId: string): Promise<boolean> {
  const rows = await tx<Array<{ exists: boolean }>>`select exists (
    select 1 from account_deletions where ${organizationId}::uuid = any(organization_ids)
  ) as exists`;
  return rows[0]?.exists === true;
}
export async function closureOrganizationExists(tx: TransactionDb, id: string): Promise<boolean> {
  const rows = await tx<Array<{ id: string }>>`select id from organizations where id = ${id}`;
  return Boolean(rows[0]);
}
export async function closureEmail(tx: TransactionDb, userId: string): Promise<string | null> {
  const rows = await tx<Array<{ email: string }>>`select email from users where id = ${userId}`;
  return rows[0]?.email ?? null;
}

export async function lockWorkerClosureUser(tx: TransactionDb, userId: string): Promise<void> {
  await tx`select public.lock_account_closure_user(${userId}::uuid)`;
}
