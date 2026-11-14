import { createHash } from "node:crypto";
import { isoInstant } from "@openedbot/contracts-primitives";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { ApnsDeviceDto, ApnsDeviceRegistrationDto } from "@openedbot/contracts-api";
import { encryptSecret, type SecretKeyring } from "@openedbot/hermes/secrets";
import { isUniqueViolation, withTenant, type Db, type TransactionDb } from "@openedbot/platform-db";
import type { ApnsRegistrationInput } from "../domain/apns";
import {
  countApnsDevices,
  deleteApnsDevice,
  deleteRevokedApnsDevices,
  insertApnsDevice,
  lockApnsDevice,
  readApnsDeviceState,
  updateApnsDevice,
  type ApnsDeviceStateRow,
} from "../sql/apns-devices";

/**
 * Registrations per member and organization, revoked ones included: a token
 * bounced between fresh installation ids must not grow the table without
 * bound. Revoked rows are dropped first when the cap is reached.
 */
const MAX_DEVICES_PER_USER = 20;

export type ApnsDeviceOwner = {
  organizationId: string;
  userId: string;
  installationId: string;
};

/** SHA-256 of the normalized (lower-case hex) token: the only form used for collisions. */
export function apnsTokenHash(token: string): string {
  return createHash("sha256").update(token.toLowerCase(), "utf8").digest("hex");
}

/**
 * `PUT /api/push/apns/devices/:installationId`. Idempotent per
 * (organization, user, installationId): the same installation re-registers
 * in place with its current token. A token held by another registration
 * (another member, organization or installation) is revoked there by the
 * 0108 trigger before this one becomes active.
 *
 * Two concurrent registrations of the same installation or token race on a
 * unique index; the loser replays once and then sees the winner's row.
 */
export async function registerApnsDevice(
  db: Db,
  owner: ApnsDeviceOwner,
  input: ApnsRegistrationInput,
  keyring: SecretKeyring,
): Promise<ApnsDeviceRegistrationDto> {
  const tokenHash = apnsTokenHash(input.token);
  const attempt = () => withOwner(db, owner, async (tx) => {
    const write = {
      organizationId: owner.organizationId,
      userId: owner.userId,
      installationId: owner.installationId,
      bundleId: input.bundleId,
      environment: input.environment,
      tokenHash,
      token: encryptSecret(input.token, keyring.current.value),
      tokenKeyId: keyring.current.id,
    };
    const existing = await lockApnsDevice(tx, owner.organizationId, owner.userId, owner.installationId);
    if (existing) return updateApnsDevice(tx, existing.id, write);
    if (await countApnsDevices(tx, owner.organizationId, owner.userId) >= MAX_DEVICES_PER_USER) {
      await deleteRevokedApnsDevices(tx, owner.organizationId, owner.userId);
      if (await countApnsDevices(tx, owner.organizationId, owner.userId) >= MAX_DEVICES_PER_USER) {
        throw new HttpError(409, "APNS_DEVICE_LIMIT", "Trop d’appareils iOS enregistrés pour ce compte.");
      }
    }
    return insertApnsDevice(tx, write);
  });
  let row: ApnsDeviceStateRow;
  try {
    row = await attempt();
  } catch (error) {
    // Lost race on (organization, user, installation) or on the active token
    // hash: the competing write has committed, so one replay converges.
    if (!isUniqueViolation(error)) throw error;
    row = await attempt();
  }
  return {
    installationId: owner.installationId,
    enabled: true,
    lastRegisteredAt: isoInstant(row.lastRegisteredAt),
  };
}

/** `GET /api/push/apns/devices/:installationId`: state only, never the token. */
export async function readApnsDevice(db: Db, owner: ApnsDeviceOwner): Promise<ApnsDeviceDto> {
  const row = await withOwner(db, owner, (tx) =>
    readApnsDeviceState(tx, owner.organizationId, owner.userId, owner.installationId));
  if (!row) throw new HttpError(404, "APNS_DEVICE_NOT_FOUND", "Cet appareil n’est pas enregistré pour les notifications.");
  return { enabled: row.enabled, lastRegisteredAt: isoInstant(row.lastRegisteredAt) };
}

/**
 * `DELETE /api/push/apns/devices/:installationId` and native logout. Idempotent:
 * an installation already gone is not an error. Pending deliveries of the
 * device go with it (FK cascade).
 */
export async function removeApnsDevice(db: Db, owner: ApnsDeviceOwner): Promise<void> {
  await withOwner(db, owner, (tx) =>
    deleteApnsDevice(tx, owner.organizationId, owner.userId, owner.installationId));
}

async function withOwner<T>(
  db: Db,
  owner: ApnsDeviceOwner,
  callback: (tx: TransactionDb) => Promise<T>,
): Promise<T> {
  return withTenant(db, owner.organizationId, async (tx) => {
    await tx`select set_config('app.authenticating_user_id', ${owner.userId}, true)`;
    return callback(tx);
  });
}
