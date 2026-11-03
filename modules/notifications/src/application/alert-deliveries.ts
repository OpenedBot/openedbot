import type { SQL } from "bun";
import { decryptSecretFromKeyring, SecretDecryptionError, type SecretKeyring } from "@openedbot/hermes/secrets";
import { withTenant } from "@openedbot/platform-db";
import {
  ALERT_DELIVERY_MAX_ATTEMPTS,
  alertRetryDelaySeconds,
  classifyDiscordResponse,
  discordAlertMessage,
  type AlertFailureReason,
  type RuntimeLinkDownPayload,
  type RuntimeLinkRestoredPayload,
} from "../domain/alert-channels";
import {
  abandonExhaustedAlertDeliveries,
  claimAlertDelivery,
  finishAlertDelivery,
  readAlertChannelSecret,
  recordAlertChannelOutcome,
  retryAlertDelivery,
  type AlertChannelOutcome,
  type ClaimedAlertDelivery,
} from "../sql/alert-channels";
import { createDiscordTransport, DiscordTransportError, type DiscordTransport } from "./discord-transport";

/** Bail d'une livraison réclamée : bien au-dessus du délai HTTP (10 s). */
const LEASE_SECONDS = 60;
const BATCH = 20;

export type AlertDeliveryPassResult = { sent: number; retried: number; failed: number; cancelled: number };

let sharedTransport: DiscordTransport | null = null;

/**
 * Envoie les livraisons d'alerte dues (worker). Sémantique, comme APNs (0108) :
 *
 * - une ligne `sent` ne repart jamais (statut et bail la gardent) ;
 * - un worker mort en plein envoi laisse une ligne `sending` dont le bail
 *   expire : elle repart, et le compteur d'essais borne la boucle. Discord n'a
 *   pas de clé d'idempotence : ce cas rare peut doubler un message, jamais le perdre ;
 * - 429 attend le `retry_after` de Discord, 5xx et délais reculent
 *   (30 s, 2 min, 8 min, 30 min), puis la ligne est `failed` ;
 * - 401, 403, 404 : le webhook n'existe plus, le canal est désactivé et
 *   l'écran le dit ;
 * - un canal supprimé ou désactivé entre le dépôt et l'envoi : `cancelled`.
 */
export async function processAlertDeliveries(
  db: SQL,
  config: { tokenEncryption: SecretKeyring; workerId: string },
  transport: DiscordTransport | null = null,
): Promise<AlertDeliveryPassResult> {
  const result: AlertDeliveryPassResult = { sent: 0, retried: 0, failed: 0, cancelled: 0 };
  const sender = transport ?? (sharedTransport ??= createDiscordTransport());
  const abandoned = await abandonExhaustedAlertDeliveries(db, ALERT_DELIVERY_MAX_ATTEMPTS);
  if (abandoned > 0) {
    result.failed += abandoned;
    console.error(JSON.stringify({ event: "worker.alert_delivery_abandoned", reason: "lease_expired", count: abandoned }));
  }
  for (let i = 0; i < BATCH; i += 1) {
    const claimed = await claimAlertDelivery(db, {
      workerId: config.workerId,
      leaseSeconds: LEASE_SECONDS,
      maxAttempts: ALERT_DELIVERY_MAX_ATTEMPTS,
    });
    if (!claimed) break;
    const outcome = await deliverOne(db, config.tokenEncryption, config.workerId, sender, claimed);
    result[outcome] += 1;
  }
  return result;
}

async function deliverOne(
  db: SQL,
  keyring: SecretKeyring,
  workerId: string,
  transport: DiscordTransport,
  delivery: ClaimedAlertDelivery,
): Promise<keyof AlertDeliveryPassResult> {
  const finish = async (status: "sent" | "failed" | "cancelled", httpStatus: number | null, reason: string | null) => {
    await finishAlertDelivery(db, { id: delivery.id, workerId, status, httpStatus, reason });
    return status;
  };
  const record = (outcome: AlertChannelOutcome) => withTenant(db, delivery.organizationId, (tx) =>
    recordAlertChannelOutcome(tx, delivery.organizationId, delivery.channelId, outcome));

  const channel = await withTenant(db, delivery.organizationId, (tx) =>
    readAlertChannelSecret(tx, delivery.organizationId, delivery.channelId));
  if (!channel || !channel.enabled) return finish("cancelled", null, "channel_disabled");

  let webhookUrl: string;
  try {
    webhookUrl = decryptSecretFromKeyring(
      { ciphertext: channel.ciphertext, nonce: channel.nonce, tag: channel.tag },
      channel.keyId,
      keyring,
    ).value;
  } catch (error) {
    if (!(error instanceof SecretDecryptionError)) throw error;
    console.error(JSON.stringify({
      event: "worker.alert_channel_undecryptable",
      organizationId: delivery.organizationId,
      channelId: delivery.channelId,
    }));
    await record({ delivered: false, reason: "decryption_failed", httpStatus: null, disable: false });
    return finish("failed", null, "decryption_failed");
  }

  const message = discordAlertMessage(
    delivery.event,
    delivery.payload as RuntimeLinkDownPayload | RuntimeLinkRestoredPayload,
  );
  let response: { status: number; retryAfterSeconds: number | null };
  try {
    response = await transport.post(webhookUrl, message);
  } catch (error) {
    if (!(error instanceof DiscordTransportError)) throw error;
    return retryOrAbandon(db, workerId, delivery, null, "unreachable", null, record);
  }

  const outcome = classifyDiscordResponse(response.status, response.retryAfterSeconds);
  if (outcome.kind === "sent") {
    await record({ delivered: true });
    return finish("sent", response.status, null);
  }
  if (outcome.kind === "revoked") {
    await record({ delivered: false, reason: "webhook_revoked", httpStatus: response.status, disable: true });
    console.info(JSON.stringify({
      event: "worker.alert_channel_revoked",
      organizationId: delivery.organizationId,
      channelId: delivery.channelId,
      httpStatus: response.status,
    }));
    return finish("failed", response.status, "webhook_revoked");
  }
  if (outcome.kind === "retry") {
    return retryOrAbandon(db, workerId, delivery, response.status, outcome.reason, outcome.delaySeconds, record);
  }
  await record({ delivered: false, reason: "rejected", httpStatus: response.status, disable: false });
  console.error(JSON.stringify({
    event: "worker.alert_delivery_rejected",
    organizationId: delivery.organizationId,
    deliveryId: delivery.id,
    httpStatus: response.status,
  }));
  return finish("failed", response.status, "rejected");
}

async function retryOrAbandon(
  db: SQL,
  workerId: string,
  delivery: ClaimedAlertDelivery,
  httpStatus: number | null,
  reason: Extract<AlertFailureReason, "rate_limited" | "unreachable">,
  announcedDelaySeconds: number | null,
  record: (outcome: AlertChannelOutcome) => Promise<void>,
): Promise<"retried" | "failed"> {
  if (delivery.attempts >= ALERT_DELIVERY_MAX_ATTEMPTS) {
    await record({ delivered: false, reason, httpStatus, disable: false });
    await finishAlertDelivery(db, { id: delivery.id, workerId, status: "failed", httpStatus, reason });
    console.error(JSON.stringify({
      event: "worker.alert_delivery_abandoned",
      organizationId: delivery.organizationId,
      deliveryId: delivery.id,
      attempts: delivery.attempts,
      httpStatus,
      reason,
    }));
    return "failed";
  }
  await retryAlertDelivery(db, {
    id: delivery.id,
    workerId,
    delaySeconds: announcedDelaySeconds ?? alertRetryDelaySeconds(delivery.attempts),
    httpStatus,
    reason,
  });
  return "retried";
}
