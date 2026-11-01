import { HttpError } from "@openedbot/contracts-errors/http-error";

export type SubscriptionSnapshot = { status: string | null | undefined } | null | undefined;

/**
 * Thin facade over `EntitlementSource`: whether billing applies is the
 * `billing.enforced` entitlement, never `BILLING_ENFORCED` read here.
 *
 * - `isEntitledBy` / `assertEntitledBy` resolve it from the source.
 * - `isEntitled` / `assertEntitled` keep their signatures for the existing
 *   callers, which pass the value already resolved at boot through the
 *   EntitlementSource (`config.billingEnforced` in the API and the worker).
 *
 * The domain does not import the application layer: `EntitlementReader` is
 * the structural part of `EntitlementSource` this facade needs.
 */
export const BILLING_ENFORCED_ENTITLEMENT = "billing.enforced";

export type EntitlementReader = {
  has(entitlement: string, scope?: { organizationId?: string | null }): Promise<boolean>;
};

export async function isEntitledBy(
  source: EntitlementReader,
  subscription: SubscriptionSnapshot,
  scope?: { organizationId?: string | null },
): Promise<boolean> {
  return isEntitled(await source.has(BILLING_ENFORCED_ENTITLEMENT, scope), subscription);
}

export async function assertEntitledBy(
  source: EntitlementReader,
  subscription: SubscriptionSnapshot,
  message?: string,
  scope?: { organizationId?: string | null },
): Promise<void> {
  assertEntitled(await source.has(BILLING_ENFORCED_ENTITLEMENT, scope), subscription, message);
}

/**
 * Un compte est habilité quand le billing est désactivé (phase de test) OU quand
 * l'abonnement est actif/en essai. Point unique pour ne pas re-décider ailleurs.
 * `billingEnforced` est la valeur résolue par l'EntitlementSource.
 */
export function isEntitled(billingEnforced: boolean, subscription: SubscriptionSnapshot): boolean {
  if (!billingEnforced) return true;
  const status = subscription?.status;
  return status === "active" || status === "trialing";
}

/**
 * Barrière d'entrée : lève 402 (past_due, paiement à régulariser) ou 403 (inactif)
 * quand le billing est appliqué et que l'abonnement ne l'autorise pas.
 */
export function assertEntitled(
  billingEnforced: boolean,
  subscription: SubscriptionSnapshot,
  message = "Un abonnement actif est requis.",
): void {
  if (isEntitled(billingEnforced, subscription)) return;
  const pastDue = subscription?.status === "past_due";
  throw new HttpError(
    pastDue ? 402 : 403,
    pastDue ? "SUBSCRIPTION_PAST_DUE" : "SUBSCRIPTION_INACTIVE",
    message,
  );
}
