import { createHash } from "node:crypto";
import type { AlertChannelDto } from "@openedbot/contracts-api";
import {
  decryptSecretFromKeyring,
  encryptSecret,
  SecretDecryptionError,
  type SecretKeyring,
} from "@openedbot/hermes/secrets";
import { withTenant, type Db } from "@openedbot/platform-db";
import {
  ALERT_CHANNEL_TEST_COOLDOWN_SECONDS,
  classifyDiscordResponse,
  discordTestMessage,
  discordWebhookHint,
  MAX_ALERT_CHANNELS_PER_ORGANIZATION,
  parseDiscordWebhookUrl,
  readAlertChannelLabel,
  type AlertFailureReason,
  type DiscordWebhookRefusal,
} from "../domain/alert-channels";
import {
  deleteAlertChannel,
  insertAlertChannel,
  listAlertChannels,
  lockAndCountAlertChannels,
  readAlertChannel,
  readAlertChannelSecret,
  recordAlertChannelOutcome,
  reserveAlertChannelTest,
  updateAlertChannel,
  type AlertChannelRow,
} from "../sql/alert-channels";
import { DiscordTransportError, type DiscordTransport } from "./discord-transport";

/** What other packages call here; the SQL file stays private to the module. */
export { enqueueRuntimeLinkDownDeliveries, enqueueRuntimeLinkRestoredDeliveries } from "../sql/alert-channels";

/**
 * Les gestes de Réglages sur les canaux d'alerte (owner et admin ; le rôle est
 * vérifié par la route). Chaque issue attendue est une valeur, pas une
 * exception : la route la traduit en code HTTP.
 */

export type AlertChannelScope = { organizationId: string; userId: string };

export function alertChannelDto(row: AlertChannelRow): AlertChannelDto {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    targetHint: row.targetHint,
    enabled: row.enabled,
    createdAt: iso(row.createdAt),
    lastDeliveredAt: row.lastDeliveredAt === null ? null : iso(row.lastDeliveredAt),
    lastFailureAt: row.lastFailureAt === null ? null : iso(row.lastFailureAt),
    lastFailureStatus: row.lastFailureStatus,
    lastFailureReason: row.lastFailureReason,
  };
}

export async function listOrganizationAlertChannels(db: Db, organizationId: string): Promise<AlertChannelDto[]> {
  const rows = await withTenant(db, organizationId, (tx) => listAlertChannels(tx, organizationId));
  return rows.map(alertChannelDto);
}

export type CreateAlertChannelResult =
  | { kind: "created"; channel: AlertChannelDto }
  | { kind: "invalid_url"; refusal: DiscordWebhookRefusal }
  | { kind: "invalid_label" }
  | { kind: "webhook_not_found"; httpStatus: number }
  | { kind: "discord_unreachable" }
  | { kind: "duplicate" }
  | { kind: "limit_reached"; limit: number };

/**
 * Ajoute un webhook Discord. Il est lu chez Discord AVANT d'être enregistré :
 * une URL copiée de travers, ou d'un webhook supprimé, est refusée tout de
 * suite plutôt que découverte le jour d'une panne. Sans libellé saisi, le
 * canal prend le nom du webhook.
 */
export async function createDiscordAlertChannel(
  db: Db,
  scope: AlertChannelScope,
  input: { webhookUrl: unknown; label: unknown },
  deps: { keyring: SecretKeyring; transport: DiscordTransport },
): Promise<CreateAlertChannelResult> {
  const webhook = parseDiscordWebhookUrl(input.webhookUrl);
  if (typeof webhook === "string") return { kind: "invalid_url", refusal: webhook };
  const typedLabel = input.label === undefined || input.label === null || input.label === ""
    ? undefined
    : readAlertChannelLabel(input.label);
  if (typedLabel === null) return { kind: "invalid_label" };

  let inspected: { status: number; name: string | null };
  try {
    inspected = await deps.transport.inspect(webhook.url);
  } catch (error) {
    if (error instanceof DiscordTransportError) return { kind: "discord_unreachable" };
    throw error;
  }
  if (inspected.status >= 500 || inspected.status === 429) return { kind: "discord_unreachable" };
  if (inspected.status < 200 || inspected.status >= 300) return { kind: "webhook_not_found", httpStatus: inspected.status };

  const label = typedLabel ?? readAlertChannelLabel(inspected.name) ?? "Discord";
  const encrypted = encryptSecret(webhook.url, deps.keyring.current.value);
  const targetHash = createHash("sha256").update(webhook.url).digest("hex");
  return withTenant(db, scope.organizationId, async (tx): Promise<CreateAlertChannelResult> => {
    const count = await lockAndCountAlertChannels(tx, scope.organizationId);
    if (count >= MAX_ALERT_CHANNELS_PER_ORGANIZATION) {
      return { kind: "limit_reached", limit: MAX_ALERT_CHANNELS_PER_ORGANIZATION };
    }
    const row = await insertAlertChannel(tx, {
      organizationId: scope.organizationId,
      kind: "discord",
      label,
      targetHint: discordWebhookHint(webhook.webhookId),
      targetHash,
      secret: { ...encrypted, keyId: deps.keyring.current.id },
      createdBy: scope.userId,
    });
    return row ? { kind: "created", channel: alertChannelDto(row) } : { kind: "duplicate" };
  });
}

export type UpdateAlertChannelResult =
  | { kind: "updated"; channel: AlertChannelDto }
  | { kind: "invalid" }
  | { kind: "not_found" };

export async function updateOrganizationAlertChannel(
  db: Db,
  organizationId: string,
  id: string,
  input: { enabled?: unknown; label?: unknown },
): Promise<UpdateAlertChannelResult> {
  const patch: { enabled?: boolean; label?: string } = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") return { kind: "invalid" };
    patch.enabled = input.enabled;
  }
  if (input.label !== undefined) {
    const label = readAlertChannelLabel(input.label);
    if (label === null) return { kind: "invalid" };
    patch.label = label;
  }
  if (patch.enabled === undefined && patch.label === undefined) return { kind: "invalid" };
  const row = await withTenant(db, organizationId, (tx) => updateAlertChannel(tx, organizationId, id, patch));
  return row ? { kind: "updated", channel: alertChannelDto(row) } : { kind: "not_found" };
}

export async function deleteOrganizationAlertChannel(db: Db, organizationId: string, id: string): Promise<boolean> {
  return withTenant(db, organizationId, (tx) => deleteAlertChannel(tx, organizationId, id));
}

export type TestAlertChannelResult =
  | { kind: "delivered"; channel: AlertChannelDto }
  | { kind: "failed"; reason: AlertFailureReason; httpStatus: number | null; channel: AlertChannelDto }
  | { kind: "cooldown"; seconds: number }
  | { kind: "not_found" };

/**
 * Envoie le message de test, maintenant, depuis l'API : l'écran dit tout de
 * suite si le salon le reçoit. L'issue s'écrit sur le canal comme celle d'une
 * vraie alerte, y compris la désactivation d'un webhook supprimé.
 */
export async function testOrganizationAlertChannel(
  db: Db,
  organizationId: string,
  id: string,
  deps: { keyring: SecretKeyring; transport: DiscordTransport; environment: string },
): Promise<TestAlertChannelResult> {
  const reserved = await withTenant(db, organizationId, async (tx) => {
    const secret = await readAlertChannelSecret(tx, organizationId, id);
    if (!secret) return { kind: "not_found" as const };
    const fresh = await reserveAlertChannelTest(tx, organizationId, id, ALERT_CHANNEL_TEST_COOLDOWN_SECONDS);
    return fresh ? { kind: "reserved" as const, secret } : { kind: "cooldown" as const };
  });
  if (reserved.kind === "not_found") return reserved;
  if (reserved.kind === "cooldown") return { kind: "cooldown", seconds: ALERT_CHANNEL_TEST_COOLDOWN_SECONDS };

  const settle = async (outcome: Parameters<typeof recordAlertChannelOutcome>[3]) =>
    withTenant(db, organizationId, async (tx) => {
      await recordAlertChannelOutcome(tx, organizationId, id, outcome);
      return readAlertChannel(tx, organizationId, id);
    });

  let webhookUrl: string;
  try {
    webhookUrl = decryptSecretFromKeyring(
      { ciphertext: reserved.secret.ciphertext, nonce: reserved.secret.nonce, tag: reserved.secret.tag },
      reserved.secret.keyId,
      deps.keyring,
    ).value;
  } catch (error) {
    if (!(error instanceof SecretDecryptionError)) throw error;
    const row = await settle({ delivered: false, reason: "decryption_failed", httpStatus: null, disable: false });
    return row ? { kind: "failed", reason: "decryption_failed", httpStatus: null, channel: alertChannelDto(row) } : { kind: "not_found" };
  }

  let response: { status: number; retryAfterSeconds: number | null };
  try {
    response = await deps.transport.post(webhookUrl, discordTestMessage(reserved.secret.label, deps.environment));
  } catch (error) {
    if (!(error instanceof DiscordTransportError)) throw error;
    const row = await settle({ delivered: false, reason: "unreachable", httpStatus: null, disable: false });
    return row ? { kind: "failed", reason: "unreachable", httpStatus: null, channel: alertChannelDto(row) } : { kind: "not_found" };
  }

  const outcome = classifyDiscordResponse(response.status, response.retryAfterSeconds);
  if (outcome.kind === "sent") {
    const row = await settle({ delivered: true });
    return row ? { kind: "delivered", channel: alertChannelDto(row) } : { kind: "not_found" };
  }
  const reason: AlertFailureReason = outcome.kind === "revoked"
    ? "webhook_revoked"
    : outcome.kind === "retry" ? outcome.reason : "rejected";
  const row = await settle({ delivered: false, reason, httpStatus: response.status, disable: outcome.kind === "revoked" });
  return row ? { kind: "failed", reason, httpStatus: response.status, channel: alertChannelDto(row) } : { kind: "not_found" };
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}
