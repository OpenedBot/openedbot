type SubscriptionDto = {
  status: string;
  currentPeriodEnd: string | null;
  runtimeLimit: number;
  memberLimit: number;
  concurrentRunLimit: number;
  attachmentQuotaBytes: number;
  updatedAt: string | null;
};

type BillingPlanDto = {
  amountEur: number;
  currency: "EUR";
  interval: "month";
  runtimeLimit: number;
  memberLimit: number;
  concurrentRunLimit: number;
  attachmentQuotaBytes: number;
};

/**
 * What the organization occupies today, against the plan ceilings.
 * Counted at read time, with exactly the filters of the guards that refuse:
 * live members as in `member-routes`, in-flight runs
 * as in the worker queue, bytes of attachments not deleted as in
 * ingress. Without these counters, the screen can only state a ceiling, never
 * whether any headroom remains.
 */
export type BillingUsageDto = {
  runtimes: number;
  members: number;
  concurrentRuns: number;
  attachmentBytes: number;
};

export type BillingDto = {
  subscription: SubscriptionDto | null;
  plan: BillingPlanDto;
  usage: BillingUsageDto;
  /** `false` until the deployment has the payment provider's keys: the screen explains that instead of a dead button. */
  configured: boolean;
  /** `false` during the test phase: access does not depend on payment, the UI hides the paywall. */
  enforced: boolean;
};
