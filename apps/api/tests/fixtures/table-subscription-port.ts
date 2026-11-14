/**
 * A test double of `SubscriptionPort` for the route tests whose fake
 * databases answer `from subscriptions` statements. The billing
 * implementation left the core with the plug-in `billing` (step 11.4); these
 * tests only need a port that reads a status and a plan through the
 * transaction they hand it, so the route's decision (refusal, paywall,
 * lock) is what they pin, not billing's SQL.
 */
import type { Db, TransactionDb } from "@openedbot/platform-db";
import type { SubscriptionPlan, SubscriptionPort } from "@openedbot/platform-db/subscription-port";

async function plan(tx: TransactionDb, organizationId: string, lock: boolean): Promise<SubscriptionPlan | null> {
  const rows = lock
    ? await tx<SubscriptionPlan[]>`select status, runtime_limit as "runtimeLimit", member_limit as "memberLimit", concurrent_run_limit as "concurrentRunLimit", attachment_quota_bytes as "attachmentQuotaBytes" from subscriptions where organization_id = ${organizationId} for update`
    : await tx<SubscriptionPlan[]>`select status, runtime_limit as "runtimeLimit", member_limit as "memberLimit", concurrent_run_limit as "concurrentRunLimit", attachment_quota_bytes as "attachmentQuotaBytes" from subscriptions where organization_id = ${organizationId}`;
  return rows[0] ?? null;
}

export const tableSubscriptionPort: SubscriptionPort = Object.freeze({
  status: async (tx: TransactionDb, organizationId: string, options?: { lock?: boolean }) => {
    const rows = options?.lock
      ? await tx<Array<{ status: string }>>`select status from subscriptions where organization_id = ${organizationId} for update`
      : await tx<Array<{ status: string }>>`select status from subscriptions where organization_id = ${organizationId}`;
    return rows[0]?.status ?? null;
  },
  read: (tx: TransactionDb, organizationId: string) => plan(tx, organizationId, false),
  readForUpdate: (tx: TransactionDb, organizationId: string) => plan(tx, organizationId, true),
  admission: (tx: Db | TransactionDb) => tx`(select organization_id, status, concurrent_run_limit from subscriptions)`,
} satisfies SubscriptionPort);
