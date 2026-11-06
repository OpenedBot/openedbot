/**
 * Tenant deletions as other packages see them (ADR 0001 S4): the API reads
 * whether one is pending, the billing plug-in schedules and cancels the one a
 * subscription's end decides. The purge itself is `./tenant-deletion`.
 */
export {
  cancelPendingTenantDeletion,
  hasPendingAccountDeletion,
  scheduleSubscriptionEndedDeletion,
} from "../sql/deletions";
