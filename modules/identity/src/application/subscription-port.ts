/**
 * What identity needs from billing: identity never reads or writes
 * `subscriptions` itself. The port is defined in
 * `@openedbot/platform-db/subscription-port`, below every module, so that execution
 * and the API routes reach it too; this path keeps identity's imports.
 */
export {
  installSubscriptionPort,
  isLiveSubscriptionStatus,
  NO_SUBSCRIPTIONS,
  subscriptionPort,
  type SubscriptionPlan,
  type SubscriptionPort,
  type SubscriptionRelation,
} from "@openedbot/platform-db/subscription-port";
