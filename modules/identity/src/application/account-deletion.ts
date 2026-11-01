import { isLiveSubscriptionStatus, subscriptionPort } from "./subscription-port";
import { isoInstant } from "@openedbot/contracts-primitives";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { requestOrganizationCancellationTx } from "@openedbot/execution/application/run-cancellation";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import {
  cancelUnclaimedAccountDeletion,
  readTenantDeletion,
  requestAccountDeletion,
  requestAccountDeletionIfAbsent,
  scopeToOrganization,
  withAccountTenant,
  type TenantDeletionRow,
} from "../sql/deletions";
import {
  countActiveMembers,
  listOtherMemberships,
  readActiveMembershipRole,
  readOrganizationFootprint,
} from "../sql/members";

export type AccountDeletionScope = { organizationId: string; userId: string };

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
  /** Internal: sole-member agency organizations that leave with the account. Never serialized. */
  soleAgencyOrganizationIds?: string[];
};

type OtherOrganization = { id: string; soleAgency: boolean };

/** L'état public : eligibilité, obstacle éventuel, demande en cours. Jamais les organisations agence internes. */
export async function readAccountDeletionState(
  db: Db,
  scope: AccountDeletionScope,
): Promise<Omit<AccountDeletionState, "soleAgencyOrganizationIds">> {
  const state = await withAccountTenant(db, scope, (tx) => readState(tx, scope));
  const { soleAgencyOrganizationIds: _internal, ...visible } = state;
  return visible;
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
): Promise<AccountDeletionState["deletion"]> {
  const deletion = await withAccountTenant(db, scope, async (tx) => {
    // The worker and the payment webhook both lock this row before touching a
    // tenant_deletions row. Keeping this order closes the claim/schedule race.
    const state = await readState(tx, scope, true);
    if (!state.eligible) throw blockerError(state.blocker!);
    // Une organisation agence dont le compte est l'unique membre part avec
    // lui : sans elle, le worker ne pourrait jamais retirer l'utilisateur.
    await scheduleSoleAgencyDeletions(tx, scope, state.soleAgencyOrganizationIds ?? [], graceDays);

    const existing = await readTenantDeletion(tx, scope.organizationId, { lock: true });
    if (existing?.startedAt) {
      throw new HttpError(409, "ACCOUNT_DELETION_IN_PROGRESS", "La suppression du compte est déjà en cours.");
    }

    const row = await requestAccountDeletion(tx, scope.organizationId, graceDays);

    // The grace period protects stored data, not active work. Runs that never
    // crossed Hermes stop locally; known remote runs enter the durable stop
    // state and ambiguous effects remain reviewable instead of being hidden.
    await requestOrganizationCancellationTx(tx, scope.organizationId, {
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
    await cancelSoleAgencyDeletions(tx, scope, await soleAgencyOrganizations(tx, scope));
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
  const role = await readActiveMembershipRole(tx, scope.organizationId, scope.userId, { lock });
  const organizationMemberCount = await countActiveMembers(tx, scope.organizationId);
  const others = await otherOrganizations(tx, scope);
  const deletion = await readTenantDeletion(tx, scope.organizationId, { lock });

  const soleAgencyOrganizationIds = others.filter((other) => other.soleAgency).map((other) => other.id);
  let blocker: DeletionBlocker | null = null;
  if (role !== "owner") blocker = "owner_required";
  else if (organizationMemberCount !== 1) blocker = "organization_shared";
  else if (others.some((other) => !other.soleAgency)) blocker = "multiple_organizations";
  else if (isLiveSubscriptionStatus(subscriptionStatus)) blocker = "active_subscription";

  return {
    eligible: blocker === null,
    blocker,
    deletion: deletion ? serializeDeletion(deletion) : null,
    soleAgencyOrganizationIds,
  };
}

/**
 * Les AUTRES organisations vivantes du compte. Une organisation agence dont il
 * est l'unique membre ne bloque pas la suppression (0086) : elle part avec lui.
 * Chaque lecture passe sous le tenant qu'elle vise, puis le tenant courant est
 * rétabli.
 */
async function otherOrganizations(tx: TransactionDb, scope: AccountDeletionScope): Promise<OtherOrganization[]> {
  const memberships = await listOtherMemberships(tx, scope.userId, scope.organizationId);
  const result: OtherOrganization[] = [];
  for (const membership of memberships) {
    await scopeToOrganization(tx, membership.id);
    const row = await readOrganizationFootprint(tx, membership.id);
    if (row) result.push({ id: membership.id, soleAgency: row.kind === "agency" && Number(row.members) === 1 });
  }
  await scopeToOrganization(tx, scope.organizationId);
  return result;
}

async function soleAgencyOrganizations(tx: TransactionDb, scope: AccountDeletionScope): Promise<string[]> {
  return (await otherOrganizations(tx, scope)).filter((other) => other.soleAgency).map((other) => other.id);
}

async function scheduleSoleAgencyDeletions(
  tx: TransactionDb, scope: AccountDeletionScope, organizationIds: string[], graceDays: number,
): Promise<void> {
  for (const organizationId of organizationIds) {
    await scopeToOrganization(tx, organizationId);
    await requestAccountDeletionIfAbsent(tx, organizationId, graceDays);
  }
  await scopeToOrganization(tx, scope.organizationId);
}

async function cancelSoleAgencyDeletions(
  tx: TransactionDb, scope: AccountDeletionScope, organizationIds: string[],
): Promise<void> {
  for (const organizationId of organizationIds) {
    await scopeToOrganization(tx, organizationId);
    await cancelUnclaimedAccountDeletion(tx, organizationId);
  }
  await scopeToOrganization(tx, scope.organizationId);
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
