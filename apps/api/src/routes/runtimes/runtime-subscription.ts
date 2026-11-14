import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { HttpError } from "../../interfaces/http/http-error";
import { subscriptionPort } from "@openedbot/platform-db/subscription-port";

export async function assertSubscriptionAllowsRuntime(db: Db, organizationId: string, billingEnforced: boolean): Promise<void> {
  await withTenant(db, organizationId, async (tx) => {
    const subscription = await subscriptionPort().read(tx, organizationId);
    // Billing enforced: requires an active subscription AND a runtime quota. Otherwise (test): let it through.
    if (billingEnforced && (!subscription || !["active", "trialing"].includes(subscription.status) || subscription.runtimeLimit < 1)) {
      throw new HttpError(402, "SUBSCRIPTION_REQUIRED", "Un abonnement actif est requis pour enregistrer Hermes.");
    }
  });
}
