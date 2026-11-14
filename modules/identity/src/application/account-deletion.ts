import { isLiveSubscriptionStatus, subscriptionPort } from "./subscription-port";
import { isoInstant } from "@openedbot/contracts-primitives";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import {
  cancelUnclaimedAccountDeletion,
  readTenantDeletion,
  requestAccountDeletion,
  scopeToOrganization,
  withAccountTenant,
  type TenantDeletionRow,
} from "../sql/deletions";
import {
  countActiveMembers,
  listOtherMemberships,
  lockOrganizationMembers,
  readActiveMembershipRole,
  isLivingOrganization,
} from "../sql/members";

export type AccountDeletionScope = { organizationId: string; userId: string };

/**
 * Stops the organization's runs when its deletion is scheduled. Runs belong
 * to the execution module, which sits above identity: the API
 * passes `requestOrganizationCancellationTx`.
 */
export type CancelOrganizationRuns = (
  tx: TransactionDb,
  organizationId: string,
  reason: { code: string; message: string },
) => Promise<unknown>;

export type DeletionBlocker =
  | "owner_required"
  | "organization_shared"
  | "multiple_organizations"
  | "active_subscription";

export type AccountDeletionState = {
  eligible: boolean;
  blocker: DeletionBlocker | null;
  deletion: {
    reason: string;
    requestedAt: string;
    purgeAfter: string | null;
    inProgress: boolean;
  } | null;
};

/** L'état public : eligibilité, obstacle éventuel, demande en cours. */
export async function readAccountDeletionState(
  db: Db,
  scope: AccountDeletionScope,
): Promise<AccountDeletionState> {
  return withAccountTenant(db, scope, (tx) => readState(tx, scope));
}

/**
 * Self-serve account deletion is deliberately tenant-scoped. The authenticated
 * user must be the sole owner/member of the current organization and must not
 * be a member of another organization. The actual purge is performed by the
 * worker through tenant_deletions; this never deletes tenant data inline.
 */
export async function scheduleAccountDeletion(
  db: Db,
  scope: AccountDeletionScope,
  graceDays: number,
  cancelOrganizationRuns: CancelOrganizationRuns,
): Promise<AccountDeletionState["deletion"]> {
  const deletion = await withAccountTenant(db, scope, async (tx) => {
    // The worker and the payment webhook both lock this row before touching a
    // tenant_deletions row. Keeping this order closes the claim/schedule race.
    const state = await readState(tx, scope, true);
    if (!state.eligible) throw blockerError(state.blocker!);

    const existing = await readTenantDeletion(tx, scope.organizationId, { lock: true });
    if (existing?.startedAt) {
      throw new HttpError(409, "ACCOUNT_DELETION_IN_PROGRESS", "La suppression du compte est déjà en cours.");
    }

    const row = await requestAccountDeletion(tx, scope.organizationId, graceDays);

    // The grace period protects stored data, not active work. Runs that never
    // crossed Hermes stop locally; known remote runs enter the durable stop
    // state and ambiguous effects remain reviewable instead of being hidden.
    await cancelOrganizationRuns(tx, scope.organizationId, {
      code: "ACCOUNT_DELETED",
      message: "Le compte a demandé sa suppression.",
    });
    return row;
  });
  return serializeDeletion(deletion);
}

/** Annule une suppression en attente ; refusée si le worker l'a déjà réclamée. Idempotente. */
export async function cancelAccountDeletion(
  db: Db,
  scope: AccountDeletionScope,
): Promise<{ cancelled: boolean; deletion: AccountDeletionState["deletion"] }> {
  return withAccountTenant(db, scope, async (tx) => {
    // Match the worker's lock order. If the worker has claimed the row, the
    // row lock below observes started_at and cancellation is refused safely.
    await subscriptionPort().status(tx, scope.organizationId, { lock: true });
    const role = await readActiveMembershipRole(tx, scope.organizationId, scope.userId, { lock: true });
    if (role !== "owner") {
      throw new HttpError(403, "ACCOUNT_DELETION_OWNER_REQUIRED", "Seul le propriétaire peut annuler la suppression du compte.");
    }
    const deletion = await readTenantDeletion(tx, scope.organizationId, { lock: true });
    if (!deletion || deletion.reason !== "account_deleted") {
      return { cancelled: false, deletion: deletion ? serializeDeletion(deletion) : null };
    }
    if (deletion.startedAt) {
      throw new HttpError(409, "ACCOUNT_DELETION_IN_PROGRESS", "La suppression du compte est déjà en cours et ne peut plus être annulée.");
    }
    await cancelUnclaimedAccountDeletion(tx, scope.organizationId);
    return { cancelled: true, deletion: null };
  });
}

async function readState(
  tx: TransactionDb,
  scope: AccountDeletionScope,
  lock = false,
): Promise<AccountDeletionState> {
  // Keep this first: worker claim/finalization and billing subscription updates
  // take the same lock before touching tenant_deletions.
  const subscriptionStatus = await subscriptionPort().status(tx, scope.organizationId, { lock });
  // Puis l'organisation (même ordre que le worker), avant le comptage : aucun
  // changement de membres ne peut s'intercaler entre ce comptage et la
  // programmation de la purge.
  if (lock) await lockOrganizationMembers(tx, scope.organizationId);
  const role = await readActiveMembershipRole(tx, scope.organizationId, scope.userId, { lock });
  const organizationMemberCount = await countActiveMembers(tx, scope.organizationId);
  const otherOrganizations = await countOtherLivingOrganizations(tx, scope);
  const deletion = await readTenantDeletion(tx, scope.organizationId, { lock });

  let blocker: DeletionBlocker | null = null;
  if (role !== "owner") blocker = "owner_required";
  else if (organizationMemberCount !== 1) blocker = "organization_shared";
  else if (otherOrganizations > 0) blocker = "multiple_organizations";
  else if (isLiveSubscriptionStatus(subscriptionStatus)) blocker = "active_subscription";

  return {
    eligible: blocker === null,
    blocker,
    deletion: deletion ? serializeDeletion(deletion) : null,
  };
}

/**
 * Les AUTRES organisations vivantes du compte. Chaque lecture passe sous le
 * tenant qu'elle vise, puis le tenant courant est rétabli.
 */
async function countOtherLivingOrganizations(tx: TransactionDb, scope: AccountDeletionScope): Promise<number> {
  const memberships = await listOtherMemberships(tx, scope.userId, scope.organizationId);
  let living = 0;
  for (const membership of memberships) {
    await scopeToOrganization(tx, membership.id);
    if (await isLivingOrganization(tx, membership.id)) living += 1;
  }
  await scopeToOrganization(tx, scope.organizationId);
  return living;
}

function blockerError(blocker: DeletionBlocker): HttpError {
  switch (blocker) {
    case "owner_required":
      return new HttpError(403, "ACCOUNT_DELETION_OWNER_REQUIRED", "Seul le propriétaire unique peut supprimer ce compte.");
    case "organization_shared":
      return new HttpError(409, "ACCOUNT_DELETION_ORGANIZATION_SHARED", "Cette organisation est partagée avec d’autres membres.");
    case "multiple_organizations":
      return new HttpError(409, "ACCOUNT_DELETION_MULTIPLE_ORGANIZATIONS", "Ce compte appartient à plusieurs organisations.");
    case "active_subscription":
      return new HttpError(409, "ACCOUNT_DELETION_SUBSCRIPTION_ACTIVE", "Résiliez l’abonnement avant de supprimer le compte.");
  }
}

function serializeDeletion(row: TenantDeletionRow): NonNullable<AccountDeletionState["deletion"]> {
  return {
    reason: row.reason,
    requestedAt: isoInstant(row.requestedAt),
    purgeAfter: row.purgeAfter ? isoInstant(row.purgeAfter) : null,
    inProgress: Boolean(row.startedAt),
  };
}
