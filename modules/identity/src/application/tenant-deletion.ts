import { isLiveSubscriptionStatus, subscriptionPort } from "./subscription-port";
import { runTenantDeleting } from "./tenant-deleting";
import { DEFAULT_LOCALE } from "@openedbot/contracts-locale";
import { enqueueTransactionalEmail } from "@openedbot/notifications/application/transactional-email";
import type { Db } from "@openedbot/platform-db";
import { cancelQueuedDeletesForDeletion } from "@openedbot/portability/application/delete-executor";
import { cancelQueuedImportsForDeletion } from "@openedbot/portability/application/executor";
import { lockProfileImports } from "@openedbot/portability/sql/reservations";
import {
  claimBlobDeletions,
  completeBlobDeletion,
  deleteOrganization,
  deleteOwnedDeletion,
  deleteUnclaimedDeletion,
  eraseAccountUser,
  findDeletionCandidate,
  hasActiveProfileDelete,
  hasActiveProfileImport,
  listAccountUsers,
  lockDeletionCandidate,
  lockOrganizationForPurge,
  lockOwnedDeletion,
  manifestTenantBlobs,
  releaseDeletionLease,
  renewDeletionLease,
  retryBlobDeletionLater,
  startDeletionLease,
  type TenantDeletionTask,
} from "../sql/deletions";

const DELETION_LEASE_SECONDS = 300;
const DELETION_MAX_ATTEMPTS = 10;
const BLOB_DELETION_LEASE_SECONDS = 300;
const BLOB_DELETION_BATCH_SIZE = 50;

/** What the purge needs from the worker: its identity, the web URL for the mail, and the blob deleter. */
export type TenantDeletionOptions = {
  workerId: string;
  webAppUrl: string;
  /**
   * Removes one stored object from the store its row names (`null`: unknown,
   * every reachable store). Idempotent; an unreachable store throws.
   */
  deleteBlob: (key: string, driver: "file" | "r2" | null) => Promise<void>;
};

class TenantDeletionLeaseLostError extends Error {
  constructor() {
    super("Tenant deletion lease was lost before the final purge.");
    this.name = "TenantDeletionLeaseLostError";
  }
}

/**
 * One maintenance pass over `tenant_deletions`: cancel what the purge would
 * race with, drain the durable blob manifest, then claim, lease and finalize
 * at most one tenant. True when something was done.
 */
export async function processTenantDeletion(db: Db, options: TenantDeletionOptions): Promise<boolean> {
  await cancelQueuedImportsForDeletion(db);
  await cancelQueuedDeletesForDeletion(db);
  const cleaned = await processTenantBlobDeletions(db, options);
  const task = await db.begin(async (tx) => {
    // Payment webhooks lock the subscription before cancelling a pending
    // deletion. Taking the same lock here closes the re-subscribe/claim race:
    // an active tenant is never claimed for purge during its grace period.
    // Find a candidate without locking it first, then lock the subscription
    // (the webhook takes this lock first) and finally claim the deletion row.
    const candidate = await findDeletionCandidate(tx, DELETION_MAX_ATTEMPTS);
    if (!candidate) return null;
    await lockProfileImports(tx, candidate.organizationId);
    const subscriptionStatus = await subscriptionPort().status(tx, candidate.organizationId, { lock: true });
    const claimed = await lockDeletionCandidate(tx, candidate.organizationId, DELETION_MAX_ATTEMPTS);
    if (!claimed) return null;
    if (isLiveSubscriptionStatus(subscriptionStatus)) {
      await deleteUnclaimedDeletion(tx, claimed.organizationId);
      return null;
    }
    await startDeletionLease(tx, claimed.organizationId, options.workerId, DELETION_LEASE_SECONDS);
    return claimed;
  }) as TenantDeletionTask | null;
  if (!task) return cleaned > 0;

  let outcome: { cancelled: boolean; deleted: boolean; blobs: number };
  try {
    if (!await renewDeletionLease(db, options.workerId, task.organizationId, DELETION_LEASE_SECONDS)) {
      throw new Error("Tenant deletion lease was lost before the final purge.");
    }
    outcome = await db.begin(async (tx) => {
      await lockProfileImports(tx, task.organizationId);
      if (await hasActiveProfileImport(tx, task.organizationId)) throw new TenantDeletionLeaseLostError();
      if (await hasActiveProfileDelete(tx, task.organizationId)) throw new TenantDeletionLeaseLostError();
      // Existing subscriptions serialize with the billing writes first. The organization
      // lock then closes the absent-subscription race and prevents any new
      // tenant child row while the durable blob manifest is captured.
      await subscriptionPort().status(tx, task.organizationId, { lock: true });
      if (!await lockOrganizationForPurge(tx, task.organizationId)) throw new TenantDeletionLeaseLostError();
      const subscriptionStatus = await subscriptionPort().status(tx, task.organizationId, { lock: true });
      const reason = await lockOwnedDeletion(tx, task.organizationId, options.workerId);
      const subscriptionActive = isLiveSubscriptionStatus(subscriptionStatus);
      if (reason === null) {
        // A billing transaction may have removed the still-untouched task while
        // this worker was between lease renewal and finalization.
        if (subscriptionActive) return { cancelled: true, deleted: false, blobs: 0 };
        throw new TenantDeletionLeaseLostError();
      }

      if (subscriptionActive) {
        await deleteOwnedDeletion(tx, task.organizationId, options.workerId);
        return { cancelled: true, deleted: false, blobs: 0 };
      }

      const accountUsers = task.reason === "account_deleted" ? await listAccountUsers(tx, task.organizationId) : [];
      const blobs = await manifestTenantBlobs(tx, task.organizationId);
      // What a listener keeps for this tenant goes in the same transaction; a
      // failure or a timeout fails the purge, which is retried later.
      await runTenantDeleting(tx, { organizationId: task.organizationId, reason: task.reason });
      if (!await deleteOrganization(tx, task.organizationId)) throw new TenantDeletionLeaseLostError();
      if (task.reason === "account_deleted") {
        for (const accountUser of accountUsers) {
          await enqueueTransactionalEmail(tx, {
            kind: "account_purge_completed",
            dedupeKey: `account-purge:${task.organizationId}:${accountUser.userId}`,
            recipientEmail: accountUser.email,
            locale: DEFAULT_LOCALE,
            payload: { purgedAt: new Date().toISOString(), webAppUrl: options.webAppUrl },
          });
        }
        for (const accountUser of accountUsers) {
          const erasure = await eraseAccountUser(tx, accountUser.userId);
          if (erasure === "pseudonymized") {
            console.info(JSON.stringify({ event: "worker.account_user_pseudonymized", userId: accountUser.userId }));
          }
        }
      }
      return { cancelled: false, deleted: true, blobs };
    });
  } catch (error) {
    await releaseDeletionLease(
      db,
      options.workerId,
      task.organizationId,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }

  if (outcome.cancelled) return true;
  if (!outcome.deleted) throw new TenantDeletionLeaseLostError();
  // The tenant is already gone. A failure here cannot resurrect it or lose the
  // manifest: a later maintenance tick reclaims the durable outbox rows.
  await processTenantBlobDeletions(db, options, task.organizationId);
  console.info(JSON.stringify({ event: "worker.tenant_deleted", organizationId: task.organizationId, blobs: outcome.blobs }));
  return true;
}

async function processTenantBlobDeletions(
  db: Db,
  options: TenantDeletionOptions,
  organizationId?: string,
): Promise<number> {
  const rows = await claimBlobDeletions(
    db,
    options.workerId,
    BLOB_DELETION_LEASE_SECONDS,
    BLOB_DELETION_BATCH_SIZE,
    organizationId,
  );

  for (const row of rows) {
    try {
      await options.deleteBlob(row.key, row.driver);
      await completeBlobDeletion(db, row.key, options.workerId);
    } catch (error) {
      const delaySeconds = Math.min(3_600, 2 ** Math.min(12, Math.max(0, row.attempts)));
      await retryBlobDeletionLater(
        db,
        row.key,
        options.workerId,
        delaySeconds,
        error instanceof Error ? error.message : String(error),
      );
      console.error(JSON.stringify({
        event: "worker.tenant_blob_delete_retry",
        organizationId: row.organizationId,
        key: row.key,
        attempts: row.attempts,
      }));
    }
  }
  return rows.length;
}
