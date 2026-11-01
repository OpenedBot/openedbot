import { Hono } from "hono";
import type { Db } from "@openedbot/platform-db";
import type { ApiConfig } from "../../infrastructure/config";
import { HttpError } from "../../interfaces/http/http-error";
import type { PaymentWebhookDelegate } from "../../application/pro-plugins";

/**
 * The payment webhook route the core mounts at the path the plug-in
 * `billing` declares (`billing.webhookPath`, step 11.5), outside the
 * session, and that only delegates (steps 8c-8d, 11.4): the core hands the
 * raw request to the plug-in with `{ db, config }` as its host and returns
 * its response unchanged. It reads no body and checks no signature: that,
 * and everything else about the payment provider, is the plug-in's.
 *
 * Billing loaded but refused by the role guard (`null`): 503
 * `PAYMENT_WEBHOOK_UNAVAILABLE`, not 404, so that the sender retries and
 * monitoring alerts. Solo mounts no route at all (`paymentWebhookMountOf`).
 */
export function paymentWebhookRoute(db: Db, config: ApiConfig, delegate: PaymentWebhookDelegate | null = null): Hono {
  const routes = new Hono();
  routes.post("/", async (context) => {
    if (delegate) return delegate(context.req.raw, { db, config });
    throw new HttpError(503, "PAYMENT_WEBHOOK_UNAVAILABLE", "Aucun module de paiement ne traite ce webhook.");
  });
  return routes;
}
