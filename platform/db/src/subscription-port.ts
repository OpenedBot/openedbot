/**
 * What the core reads of an organization's subscription, as a port: outside
 * billing, nothing reads or writes `subscriptions` itself (`make deps-check`,
 * `tests/scripts/subscription-port-contract.ts`).
 *
 * It lives here, under every module, because identity (organization creation,
 * members, deletion), execution (run queue, routines) and the API routes all
 * need it and identity already depends on execution. Identity re-exports it
 * from `@openedbot/identity/application/subscription-port`.
 *
 * The core default (`NO_SUBSCRIPTIONS`) is solo: no member limit, no
 * subscription anywhere. A billing implementation is installed by the
 * composition roots (API and worker) with `installSubscriptionPort`, only
 * from the plug-in billing (`ProPlugin.billing.subscriptions`, step 8d). The
 * welcome subscription is no longer a port member: it is written by the
 * plug-in's `onOrganizationCreating` hook, in the creation transaction.
 */
import type { Db, TransactionDb } from "./db";

/** What the core decides from: the status and the plan quotas. */
export type SubscriptionPlan = {
  readonly status: string;
  readonly runtimeLimit: number;
  readonly memberLimit: number;
  readonly concurrentRunLimit: number;
  /** A `bigint` column, as the driver returns it (a decimal string). */
  readonly attachmentQuotaBytes: string | number;
};

/**
 * A relation `(organization_id uuid, status text, concurrent_run_limit integer)`,
 * at most one row per organization, for a set-based query to `left join`
 * (`left join ${port.admission(tx)} s on s.organization_id = …`). It is a SQL
 * fragment, built synchronously from the caller's `tx` and executed only as
 * part of the caller's statement: never `await` it on its own. The caller's
 * `for update of …` never names it, so it takes no lock.
 */
export type SubscriptionRelation = Bun.SQL.Query<unknown>;

export type SubscriptionPort = {
  /**
   * The subscription status, `null` without a subscription. With `lock`, it
   * takes the row lock that orders a deletion against concurrent billing
   * updates (subscription first, then organization, then `tenant_deletions`).
   */
  status(tx: TransactionDb, organizationId: string, options?: { lock?: boolean }): Promise<string | null>;
  /** The organization's plan, `null` without a subscription. Takes no lock. */
  read(tx: TransactionDb, organizationId: string): Promise<SubscriptionPlan | null>;
  /**
   * The same read, `for update`, in the caller's transaction: the row stays
   * locked until that transaction ends, so a concurrent billing write (a
   * payment webhook) is ordered after the decision the caller takes from it.
   * Without a subscription there is no row, hence no lock, as before.
   */
  readForUpdate(tx: TransactionDb, organizationId: string): Promise<SubscriptionPlan | null>;
  /** The relation a set-based admission query joins (run queue, routine scheduler). */
  admission(tx: Db | TransactionDb): SubscriptionRelation;
};

/** Solo: no subscription anywhere, no limit. */
export const NO_SUBSCRIPTIONS: SubscriptionPort = Object.freeze({
  status: async () => null,
  read: async () => null,
  readForUpdate: async () => null,
  admission: (tx: Db | TransactionDb) => tx`(
    select null::uuid as organization_id, null::text as status, null::integer as concurrent_run_limit
     where false
  )`,
});

let installed: SubscriptionPort = NO_SUBSCRIPTIONS;

/** Installs the billing implementation; `null` restores the solo default. */
export function installSubscriptionPort(port: SubscriptionPort | null): void {
  installed = port ?? NO_SUBSCRIPTIONS;
}

export function subscriptionPort(): SubscriptionPort {
  return installed;
}

/** True for a status that keeps an organization out of purge and deletion (active or trialing). */
export function isLiveSubscriptionStatus(status: string | null): boolean {
  return status === "active" || status === "trialing";
}
