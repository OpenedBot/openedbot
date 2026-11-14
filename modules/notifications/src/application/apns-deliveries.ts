import type { SQL } from "bun";
import { decryptSecretFromKeyring, SecretDecryptionError, type SecretKeyring } from "@openedbot/hermes/secrets";
import { withTenant } from "@openedbot/platform-db";
import type { ApnsConfig } from "@openedbot/platform-integrations/apns";
import {
  apnsCollapseId,
  apnsPayload,
  apnsPriority,
  apnsRetryDelaySeconds,
  classifyApnsResponse,
} from "../domain/apns";
import { isPushEventType } from "../domain/push-payload";
import {
  abandonExhaustedApnsDeliveries,
  claimApnsDelivery,
  finishApnsDelivery,
  listFanoutApnsDevices,
  readApnsDeviceSecret,
  reserveApnsDeliveries,
  retryApnsDelivery,
  revokeApnsDevice,
  touchApnsDevice,
  type ClaimedApnsDelivery,
} from "../sql/apns-devices";
import { ApnsTransportError, createApnsTransport, type ApnsTransport } from "./apns-transport";

/**
 * At most this many HTTP attempts per (outbox row, device). A claim counts as
 * an attempt, so a worker crash loop also ends here.
 */
export const APNS_MAX_ATTEMPTS = 5;
/** Lease of a claimed delivery: well above the HTTP timeout (10 s). */
const LEASE_SECONDS = 60;
const BATCH = 20;
/** Apple keeps an undelivered notification this long for an offline device. */
const EXPIRATION_SECONDS = 86_400;

export type ApnsPassResult = { sent: number; retried: number; failed: number; revoked: number };

/**
 * Fan-out of one claimed `push_outbox` row to the APNs devices of the tenant
 * (worker, under `withTenant`). Only devices registered before the transition
 * and transitions younger than 24 h: a new device never replays history, and
 * a backlog drained late is not pushed. Idempotent through the unique
 * (outbox_id, device_id) key; returns the number of eligible devices.
 */
export async function fanOutApnsDeliveries(
  db: SQL,
  organizationId: string,
  outboxId: string,
): Promise<number> {
  return withTenant(db, organizationId, async (tx) => {
    const devices = await listFanoutApnsDevices(tx, organizationId, outboxId);
    await reserveApnsDeliveries(tx, organizationId, outboxId, devices.map((device) => device.id));
    return devices.length;
  });
}

const sharedTransports = new WeakMap<ApnsConfig, ApnsTransport>();

/** One HTTP/2 client per configuration for the life of the worker process. */
function sharedTransport(config: ApnsConfig): ApnsTransport {
  let transport = sharedTransports.get(config);
  if (!transport) {
    transport = createApnsTransport(config);
    sharedTransports.set(config, transport);
  }
  return transport;
}

/**
 * Sends the due APNs deliveries. Delivery semantics:
 *
 * - a `sent` row is never sent again (fenced by its status and lease);
 * - a worker that dies mid-send leaves a `sending` row whose lease expires:
 *   it is re-sent with the same `apns-id` and `apns-collapse-id`, so the
 *   device shows one notification, and the attempt counter bounds the loop;
 * - 429 / 5xx / timeouts back off (30 s, 2 min, 8 min, 30 min), then the row
 *   is recorded `failed` with the last HTTP status and APNs reason;
 * - 410 / BadDeviceToken / DeviceTokenNotForTopic revoke the device.
 */
export async function processApnsDeliveries(
  db: SQL,
  config: { apns: ApnsConfig | null; tokenEncryption: SecretKeyring; workerId: string },
  transport: ApnsTransport | null = null,
): Promise<ApnsPassResult> {
  const result: ApnsPassResult = { sent: 0, retried: 0, failed: 0, revoked: 0 };
  if (!config.apns) return result;
  const sender = transport ?? sharedTransport(config.apns);
  const abandoned = await abandonExhaustedApnsDeliveries(db, APNS_MAX_ATTEMPTS);
  if (abandoned > 0) {
    result.failed += abandoned;
    console.error(JSON.stringify({ event: "worker.apns_delivery_abandoned", reason: "LeaseExpired", count: abandoned }));
  }
  for (let i = 0; i < BATCH; i += 1) {
    const claimed = await claimApnsDelivery(db, {
      workerId: config.workerId,
      leaseSeconds: LEASE_SECONDS,
      maxAttempts: APNS_MAX_ATTEMPTS,
    });
    if (!claimed) break;
    const outcome = await deliverOne(db, config.apns, config.tokenEncryption, config.workerId, sender, claimed);
    result[outcome] += 1;
  }
  return result;
}

async function deliverOne(
  db: SQL,
  apns: ApnsConfig,
  keyring: SecretKeyring,
  workerId: string,
  transport: ApnsTransport,
  delivery: ClaimedApnsDelivery,
): Promise<keyof ApnsPassResult> {
  const finish = async (status: "sent" | "failed" | "revoked", httpStatus: number | null, reason: string | null) => {
    await finishApnsDelivery(db, { id: delivery.id, workerId, status, httpStatus, reason });
    return status;
  };
  if (!isPushEventType(delivery.eventType) || !delivery.threadId || !delivery.workflowKind) {
    return finish("failed", null, "InvalidOutbox");
  }

  const device = await withTenant(db, delivery.organizationId, (tx) =>
    readApnsDeviceSecret(tx, delivery.organizationId, delivery.deviceId));
  if (!device || device.revoked || !device.memberActive
    || !device.ciphertext || !device.nonce || !device.tag) {
    // Revoked between fan-out and send (logout, token moved, member removed).
    return finish("revoked", null, "DeviceRevoked");
  }
  if (!apns.bundleIds.includes(device.bundleId)) {
    return finish("failed", null, "TopicNotAllowed");
  }

  let deviceToken: string;
  try {
    deviceToken = decryptSecretFromKeyring(
      { ciphertext: device.ciphertext, nonce: device.nonce, tag: device.tag },
      device.keyId,
      keyring,
    ).value;
  } catch (error) {
    if (!(error instanceof SecretDecryptionError)) throw error;
    console.error(JSON.stringify({
      event: "worker.apns_token_undecryptable",
      organizationId: delivery.organizationId,
      deviceId: delivery.deviceId,
    }));
    return finish("failed", null, "DecryptionFailed");
  }

  const eventType = delivery.eventType;
  const payload = apnsPayload({
    eventType,
    workflowKind: delivery.workflowKind,
    name: delivery.workflowKind === "group" ? delivery.groupName ?? delivery.botName : delivery.botName,
    threadId: delivery.threadId,
    organizationId: delivery.organizationId,
  });

  let status: number;
  let reason: string | null;
  try {
    const response = await transport.send({
      environment: device.environment,
      deviceToken,
      topic: device.bundleId,
      apnsId: delivery.id,
      collapseId: apnsCollapseId({
        eventType,
        workflowId: delivery.workflowId,
        notificationSequence: delivery.notificationSequence,
      }),
      priority: apnsPriority(eventType),
      expiration: Math.floor(Date.now() / 1_000) + EXPIRATION_SECONDS,
      payload: JSON.stringify(payload),
    });
    status = response.status;
    reason = response.reason;
  } catch (error) {
    if (!(error instanceof ApnsTransportError)) throw error;
    return retryOrAbandon(db, workerId, delivery, null, error.code);
  }

  const outcome = classifyApnsResponse(status, reason);
  if (outcome.kind === "sent") {
    await withTenant(db, delivery.organizationId, (tx) =>
      touchApnsDevice(tx, delivery.organizationId, delivery.deviceId));
    return finish("sent", status, null);
  }
  if (outcome.kind === "revoke") {
    const revoked = await withTenant(db, delivery.organizationId, (tx) =>
      revokeApnsDevice(tx, delivery.organizationId, delivery.deviceId, device.tokenHash, outcome.reason));
    console.info(JSON.stringify({
      // Not revoked: the installation registered a new token meanwhile.
      event: revoked ? "worker.apns_device_revoked" : "worker.apns_stale_token_rejected",
      organizationId: delivery.organizationId,
      deviceId: delivery.deviceId,
      httpStatus: status,
      reason: outcome.reason,
    }));
    return finish("revoked", status, reason);
  }
  if (outcome.kind === "retry") {
    if (outcome.refreshProviderToken) transport.invalidateProviderToken();
    return retryOrAbandon(db, workerId, delivery, status, reason);
  }
  console.error(JSON.stringify({
    event: "worker.apns_delivery_rejected",
    organizationId: delivery.organizationId,
    deliveryId: delivery.id,
    httpStatus: status,
    reason,
  }));
  return finish("failed", status, reason);
}

async function retryOrAbandon(
  db: SQL,
  workerId: string,
  delivery: ClaimedApnsDelivery,
  httpStatus: number | null,
  reason: string | null,
): Promise<"retried" | "failed"> {
  if (delivery.attempts >= APNS_MAX_ATTEMPTS) {
    await finishApnsDelivery(db, { id: delivery.id, workerId, status: "failed", httpStatus, reason });
    console.error(JSON.stringify({
      event: "worker.apns_delivery_abandoned",
      organizationId: delivery.organizationId,
      deliveryId: delivery.id,
      attempts: delivery.attempts,
      httpStatus,
      reason,
    }));
    return "failed";
  }
  await retryApnsDelivery(db, {
    id: delivery.id,
    workerId,
    delaySeconds: apnsRetryDelaySeconds(delivery.attempts),
    httpStatus,
    reason,
  });
  return "retried";
}
