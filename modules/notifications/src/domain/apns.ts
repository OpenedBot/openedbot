import { HttpError } from "@openedbot/contracts-errors/http-error";
import { t } from "@openedbot/contracts-i18n";
import type { PushEventType } from "./push-payload";

export type ApnsEnvironment = "sandbox" | "production";

/**
 * `kind` of the `openedbot` block the iOS client routes on. v1 produces only
 * `approval` and `workflow` (the transitions `push_outbox` already carries);
 * `needs_you` and `needs_review` are part of the client contract and reserved
 * until an outbox producer emits them.
 */
export type ApnsNotificationKind = "approval" | "workflow" | "needs_you" | "needs_review";

export type ApnsPayload = {
  aps: {
    alert: { title: string; body: string };
    sound: "default";
    "thread-id": string;
  };
  openedbot: {
    kind: ApnsNotificationKind;
    threadId: string;
    organizationId: string;
  };
};

export type ApnsRegistrationInput = {
  token: string;
  bundleId: string;
  environment: ApnsEnvironment;
};

const INSTALLATION_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** APNs device tokens are hex; 32 bytes today, Apple reserves the right to grow them. */
const DEVICE_TOKEN = /^(?:[0-9a-f]{2}){32,100}$/;
const TITLE_MAX = 200;
const FALLBACK_TITLE = "openedbot";

export function readApnsInstallationId(value: unknown): string {
  if (typeof value !== "string" || !INSTALLATION_ID.test(value)) {
    throw new HttpError(400, "VALIDATION_ERROR", "L’identifiant d’installation est invalide.");
  }
  return value;
}

/**
 * Reads `{ token, bundleId, environment }`. The token is normalized to lower
 * case hex before hashing, so the same device never hashes two ways.
 */
export function readApnsRegistrationInput(
  body: Record<string, unknown>,
  allowedBundleIds: readonly string[],
): ApnsRegistrationInput {
  const rawToken = typeof body.token === "string" ? body.token.trim().toLowerCase() : "";
  if (!DEVICE_TOKEN.test(rawToken)) {
    throw new HttpError(400, "APNS_TOKEN_INVALID", "Le jeton APNs de l’appareil est invalide.");
  }
  const bundleId = typeof body.bundleId === "string" ? body.bundleId.trim() : "";
  if (!bundleId) throw new HttpError(400, "VALIDATION_ERROR", "L’identifiant d’application est requis.");
  if (!allowedBundleIds.includes(bundleId)) {
    throw new HttpError(400, "APNS_BUNDLE_ID_NOT_ALLOWED", "Cette application n’est pas autorisée à recevoir des notifications.");
  }
  const environment = body.environment;
  if (environment !== "sandbox" && environment !== "production") {
    throw new HttpError(400, "VALIDATION_ERROR", "L’environnement APNs doit être « sandbox » ou « production ».");
  }
  return { token: rawToken, bundleId, environment };
}

export function apnsKind(eventType: PushEventType): ApnsNotificationKind {
  return eventType === "approval.requested" ? "approval" : "workflow";
}

/** Approvals wake the device (10); a finished workflow is delivered power-aware (5). */
export function apnsPriority(eventType: PushEventType): 5 | 10 {
  return eventType === "approval.requested" ? 10 : 5;
}

/**
 * One collapse identifier per approval transition, one per workflow for its
 * outcome: a retried delivery replaces itself on the device instead of
 * showing twice. At most 64 bytes (APNs limit): ids are UUIDs.
 */
export function apnsCollapseId(input: {
  eventType: PushEventType;
  workflowId: string;
  notificationSequence: number;
}): string {
  return input.eventType === "approval.requested"
    ? `approval:${input.workflowId}:${input.notificationSequence}`
    : `workflow:${input.workflowId}`;
}

/**
 * App-written French public copy only: the bot or group name as the title,
 * the transition as the body. Never message text, a runtime error, a secret
 * or a signed URL. The device carries no locale, and the client is French.
 */
export function apnsPayload(input: {
  eventType: PushEventType;
  workflowKind: "dm" | "group" | "routine";
  /** Group name for a group workflow, else the bot name snapshot of the outbox row. */
  name: string | null;
  threadId: string;
  organizationId: string;
}): ApnsPayload {
  const title = input.name?.trim().slice(0, TITLE_MAX) || FALLBACK_TITLE;
  return {
    aps: {
      alert: { title, body: apnsBody(input.eventType, input.workflowKind) },
      sound: "default",
      "thread-id": input.threadId,
    },
    openedbot: {
      kind: apnsKind(input.eventType),
      threadId: input.threadId,
      organizationId: input.organizationId,
    },
  };
}

export function apnsBody(eventType: PushEventType, workflowKind: "dm" | "group" | "routine"): string {
  if (eventType === "approval.requested") return t("fr", "pushNotifications.apnsApprovalPending");
  const completed = eventType === "run.completed";
  if (workflowKind === "routine") {
    return t("fr", completed ? "pushNotifications.apnsRoutineCompleted" : "pushNotifications.apnsRoutineFailed");
  }
  if (workflowKind === "group") {
    return t("fr", completed ? "pushNotifications.apnsGroupCompleted" : "pushNotifications.apnsGroupFailed");
  }
  return t("fr", completed ? "pushNotifications.runCompleted" : "pushNotifications.runError");
}

export type ApnsRevocationReason = "unregistered" | "bad_device_token" | "device_token_not_for_topic";

/**
 * What one APNs answer means for the delivery and the device.
 *
 * - 200: sent.
 * - 410 (Unregistered, ExpiredToken), 400 BadDeviceToken and
 *   400 DeviceTokenNotForTopic: the registration itself is dead; the device
 *   is revoked and the delivery is not retried.
 * - 429, 5xx: transient, retried with bounded backoff.
 * - 403 ExpiredProviderToken / InvalidProviderToken: our JWT; retried after
 *   the cached token is dropped (a key rotation must not lose deliveries).
 * - Any other 4xx: the request itself is wrong; failed without retry.
 */
export type ApnsOutcome =
  | { kind: "sent" }
  | { kind: "revoke"; reason: ApnsRevocationReason }
  | { kind: "retry"; refreshProviderToken: boolean }
  | { kind: "fail" };

export function classifyApnsResponse(status: number, reason: string | null): ApnsOutcome {
  if (status === 200) return { kind: "sent" };
  if (status === 410) return { kind: "revoke", reason: "unregistered" };
  if (status === 400 && reason === "BadDeviceToken") return { kind: "revoke", reason: "bad_device_token" };
  if (status === 400 && reason === "DeviceTokenNotForTopic") return { kind: "revoke", reason: "device_token_not_for_topic" };
  if (status === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")) {
    return { kind: "retry", refreshProviderToken: true };
  }
  if (status === 429 || status >= 500) return { kind: "retry", refreshProviderToken: false };
  return { kind: "fail" };
}

/** Delay before attempt `attempts + 1`: 30 s, 2 min, 8 min, then 30 min (capped). */
export function apnsRetryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(30 * 4 ** exponent, 1_800);
}

/** APNs `reason` values are single words; anything else is not recorded. */
export function apnsReasonCode(reason: unknown): string | null {
  return typeof reason === "string" && /^[A-Za-z]{1,64}$/.test(reason) ? reason : null;
}
