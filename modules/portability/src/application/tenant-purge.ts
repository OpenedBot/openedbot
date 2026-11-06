import type { TenantPurgeProfileJobs } from "@openedbot/identity/application/tenant-deletion";
import { lockProfileImports } from "@openedbot/roster/application/profile-reservations";
import { cancelQueuedDeletesForDeletion } from "./delete-executor";
import { cancelQueuedImportsForDeletion } from "./executor";

/** The profile jobs a tenant purge races with, for `processTenantDeletion` (identity). */
export const tenantPurgeProfileJobs: TenantPurgeProfileJobs = {
  cancelQueuedImports: cancelQueuedImportsForDeletion,
  cancelQueuedDeletes: cancelQueuedDeletesForDeletion,
  lockImports: lockProfileImports,
};
