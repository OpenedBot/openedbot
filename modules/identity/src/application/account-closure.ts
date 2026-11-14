import { lockUserSessions } from "../sql/sessions";
import { DEFAULT_LOCALE } from "@openedbot/contracts-locale";
import { enqueueTransactionalEmail } from "@openedbot/notifications/application/transactional-email";
import type { AccountDeletionBlocker, AccountDeletionDto, AccountDeletionStateDto } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { isoInstant } from "@openedbot/contracts-primitives";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { isLiveSubscriptionStatus, subscriptionPort } from "./subscription-port";
import { cancelAccountDeletion as cancelLegacyDeletion, type AccountDeletionScope, type CancelOrganizationRuns } from "./account-deletion";
import { cancelUnclaimedAccountDeletion, readTenantDeletion, requestAccountDeletion, scopeToOrganization, withAccountTenant, type TenantDeletionRow } from "../sql/deletions";
import { lockOrganizationMembers } from "../sql/members";
import { closureEmail, closureOrganizationExists, deleteClosure, finalizeClosure, insertClosure, listClosureMemberships, lockClosureUser, lockWorkerClosureUser, nextClosure, readClosure, readClosureOrganization, recordClosureAttempt } from "../sql/account-closures";
export { pendingAccountClosure } from "../sql/account-closures";

type Plan = AccountDeletionStateDto & { tenantIds: string[] };

/** Lock order: session-family mutex, subscriptions, organizations (sorted), user, jobs.
 * A membership change takes organization -> user; tenant purge takes subscription
 * -> organization -> tenant job. Never lock a user/job before those resources. */
async function plan(tx: TransactionDb, scope: AccountDeletionScope, lock = false, worker = false): Promise<Plan> {
  const before = await listClosureMemberships(tx, scope.userId);
  const job = await readClosure(tx, scope.userId);
  const ids = [...new Set([...before.map((row) => row.id), ...(job?.organizationIds ?? [])])].sort();
  if (lock) {
    await lockUserSessions(tx, scope.userId);
    for (const id of ids) {
      await scopeToOrganization(tx, id);
      await subscriptionPort().status(tx, id, { lock: true });
    }
    for (const id of ids) {
      await scopeToOrganization(tx, id);
      await lockOrganizationMembers(tx, id);
    }
    // Session rotation holds the family mutex before touching sessions/users.
    // Both API and worker take it BEFORE user/job locks, including cancellation.
    if (worker) await lockWorkerClosureUser(tx, scope.userId);
    else {
      await lockClosureUser(tx, scope.userId);
    }
    const after = await listClosureMemberships(tx, scope.userId);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new HttpError(409, "ACCOUNT_DELETION_CHANGED", "Vos espaces ont changé. Actualisez et réessayez.");
    }
  }
  const closure = await readClosure(tx, scope.userId, lock);
  const organizations: AccountDeletionStateDto["organizations"] = [];
  let blocker: AccountDeletionBlocker | null = null;
  let legacy: TenantDeletionRow | null = null;
  let inProgress = Boolean(closure?.startedAt);
  for (const id of ids) {
    await scopeToOrganization(tx, id);
    const org = await readClosureOrganization(tx, id, scope.userId);
    const deletion = await readTenantDeletion(tx, id, { lock });
    if (closure?.organizationIds.includes(id) && (deletion?.startedAt || !await closureOrganizationExists(tx, id))) inProgress = true;
    if (!org) continue;
    const action = org.members === 1 && org.role === "owner" && (!closure || closure.organizationIds.includes(id)) ? "delete" : "leave";
    organizations.push({ id, name: org.name, action });
    if (org.role === "owner" && action === "leave" && org.otherOwners === 0) blocker = "transfer_required";
    if (action === "delete" && isLiveSubscriptionStatus(await subscriptionPort().status(tx, id))) blocker ??= "active_subscription";
    if (deletion && !closure?.organizationIds.includes(id)) {
      blocker ??= "tenant_deletion_pending";
      if (id === scope.organizationId && deletion.reason === "account_deleted") legacy = deletion;
    }
  }
  await scopeToOrganization(tx, scope.organizationId);
  return { eligible: blocker === null, blocker, organizations,
    tenantIds: organizations.filter((org) => org.action === "delete").map((org) => org.id),
    deletion: closure ? { ...serialize(closure), inProgress } : legacy ? serialize(legacy) : null };
}

export async function readAccountClosureState(db: Db, scope: AccountDeletionScope): Promise<AccountDeletionStateDto> {
  const { tenantIds: _, ...state } = await withAccountTenant(db, scope, (tx) => plan(tx, scope));
  return state;
}
export async function scheduleAccountClosure(db: Db, scope: AccountDeletionScope, graceDays: number,
  cancelRuns: CancelOrganizationRuns, expectedOrganizationIds?: string[]): Promise<AccountDeletionDto> {
  return withAccountTenant(db, scope, async (tx) => {
    const state = await plan(tx, scope, true);
    const existing = await readClosure(tx, scope.userId, true);
    if (existing) return serialize(existing);
    if (state.blocker) throw blockerError(state.blocker);
    // Old clients can still close their one selected sole-owned workspace.
    const expected = expectedOrganizationIds ?? (state.tenantIds.length === 0 ? []
      : state.organizations.length === 1 ? state.tenantIds : [scope.organizationId]);
    if (JSON.stringify([...expected].sort()) !== JSON.stringify(state.tenantIds)) {
      throw new HttpError(409, "ACCOUNT_DELETION_CHANGED", "Vérifiez la liste des espaces à supprimer avant de confirmer.");
    }
    for (const id of state.tenantIds) {
      await scopeToOrganization(tx, id);
      await requestAccountDeletion(tx, id, graceDays);
      await cancelRuns(tx, id, { code: "ACCOUNT_DELETED", message: "Le compte a demandé sa suppression." });
    }
    await insertClosure(tx, scope.userId, state.tenantIds, graceDays);
    const row = await readClosure(tx, scope.userId);
    if (!row) throw new Error("Account closure was not persisted.");
    return serialize(row);
  });
}
export async function cancelAccountClosure(db: Db, scope: AccountDeletionScope): Promise<{ cancelled: boolean; deletion: AccountDeletionDto | null }> {
  const result = await withAccountTenant(db, scope, async (tx) => {
    await plan(tx, scope, true);
    const job = await readClosure(tx, scope.userId, true);
    if (!job) return null;
    for (const id of job.organizationIds) {
      await scopeToOrganization(tx, id);
      const deletion = await readTenantDeletion(tx, id, { lock: true });
      // Billing may remove/replace an unstarted job: that is reversible.
      // A disappeared organization or claimed job is not.
      if (deletion?.startedAt || !await closureOrganizationExists(tx, id)) {
        throw new HttpError(409, "ACCOUNT_DELETION_IN_PROGRESS", "La suppression a commencé ou un espace a changé. La fermeture ne peut plus être annulée automatiquement.");
      }
    }
    for (const id of job.organizationIds) {
      await scopeToOrganization(tx, id);
      await cancelUnclaimedAccountDeletion(tx, id);
    }
    await deleteClosure(tx, scope.userId);
    return { cancelled: true, deletion: null };
  });
  if (result) return result;
  // Keep cancellation of pre-migration requests working for existing clients.
  const legacy = await withAccountTenant(db, scope, (tx) => readTenantDeletion(tx, scope.organizationId));
  return legacy?.reason === "account_deleted" ? cancelLegacyDeletion(db, scope) : { cancelled: false, deletion: null };
}

/** No remote side effects: one transaction is the claim AND finalization. A
 * rollback is retryable, a crash after commit finds no job. Slow/blocked jobs
 * are retried at most once per minute and do not starve other identities. */
export async function processAccountClosure(db: Db, webAppUrl: string): Promise<boolean> {
  const candidate = await nextClosure(db);
  if (!candidate) return false;
  try {
    const done = await db.begin(async (tx) => {
      const scope = { userId: candidate.userId, organizationId: "00000000-0000-0000-0000-000000000000" };
      const state = await plan(tx, scope, true, true);
      if (state.blocker) throw blockerError(state.blocker);
      const job = await readClosure(tx, candidate.userId, true);
      if (!job) return false;
      // Billing can cancel a tenant purge during grace. Once that subscription
      // is inactive again, recreate only the originally confirmed solo jobs.
      for (const id of job.organizationIds) {
        await scopeToOrganization(tx, id);
        if (await closureOrganizationExists(tx, id) && !await readTenantDeletion(tx, id)) {
          if (!state.tenantIds.includes(id)) throw blockerError("transfer_required");
          await requestAccountDeletion(tx, id, 0);
        }
      }
      const email = await closureEmail(tx, candidate.userId);
      const finalized = await finalizeClosure(tx, candidate.userId);
      if (finalized && email) await enqueueTransactionalEmail(tx, {
        kind: "account_purge_completed", dedupeKey: `account-closure:${candidate.userId}`,
        recipientEmail: email, locale: DEFAULT_LOCALE,
        payload: { purgedAt: new Date().toISOString(), webAppUrl },
      });
      return finalized;
    }) as boolean;
    if (!done) await recordClosureAttempt(db, candidate.userId, null);
    return done;
  } catch (error) {
    await recordClosureAttempt(db, candidate.userId, error instanceof HttpError ? error.code : "ACCOUNT_CLOSURE_RETRY");
    throw error;
  }
}
function blockerError(blocker: AccountDeletionBlocker): HttpError {
  if (blocker === "transfer_required") return new HttpError(409, "ACCOUNT_DELETION_TRANSFER_REQUIRED", "Transférez la propriété de chaque espace partagé avant de fermer votre compte.");
  if (blocker === "active_subscription") return new HttpError(409, "ACCOUNT_DELETION_SUBSCRIPTION_ACTIVE", "Résiliez les abonnements des espaces à supprimer avant de fermer votre compte.");
  return new HttpError(409, "ACCOUNT_DELETION_TENANT_PENDING", "Un espace possède déjà une demande de suppression. Annulez-la avant de fermer votre compte.");
}
function serialize(row: TenantDeletionRow): AccountDeletionDto {
  return { reason: row.reason, requestedAt: isoInstant(row.requestedAt), purgeAfter: row.purgeAfter ? isoInstant(row.purgeAfter) : null, inProgress: Boolean(row.startedAt) };
}
