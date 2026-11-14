import type { Db, TransactionDb } from "@openedbot/platform-db";
import type { EncryptedSecret } from "@openedbot/hermes/secrets";
import type { ApnsEnvironment, ApnsRevocationReason } from "../domain/apns";

/**
 * SQL of the APNs device registry (0108). API callers run inside
 * `withTenant` + `app.authenticating_user_id` (policy `apns_devices_owner`);
 * worker callers run inside `withTenant` (policy `apns_devices_worker`). No
 * function here returns the token, its hash or its ciphertext to an API
 * caller.
 */

export type ApnsDeviceStateRow = {
  id: string;
  enabled: boolean;
  lastRegisteredAt: Date | string;
};

export type ApnsDeviceWrite = {
  organizationId: string;
  userId: string;
  installationId: string;
  bundleId: string;
  environment: ApnsEnvironment;
  tokenHash: string;
  token: EncryptedSecret;
  tokenKeyId: string;
};

export async function lockApnsDevice(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  installationId: string,
): Promise<ApnsDeviceStateRow | null> {
  const rows = await tx<ApnsDeviceStateRow[]>`
    select id, revoked_at is null as enabled, last_registered_at as "lastRegisteredAt"
      from apns_devices
     where organization_id = ${organizationId} and user_id = ${userId}
       and installation_id = ${installationId}
     for update
  `;
  return rows[0] ?? null;
}

export async function readApnsDeviceState(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  installationId: string,
): Promise<ApnsDeviceStateRow | null> {
  const rows = await tx<ApnsDeviceStateRow[]>`
    select id, revoked_at is null as enabled, last_registered_at as "lastRegisteredAt"
      from apns_devices
     where organization_id = ${organizationId} and user_id = ${userId}
       and installation_id = ${installationId}
  `;
  return rows[0] ?? null;
}

/** All registrations of a member in the organization, revoked ones included. */
export async function countApnsDevices(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
): Promise<number> {
  const rows = await tx<Array<{ count: number }>>`
    select count(*)::int as count from apns_devices
     where organization_id = ${organizationId} and user_id = ${userId}
  `;
  return rows[0]?.count ?? 0;
}

/** Drops the member's revoked registrations (secret already erased) to make room. */
export async function deleteRevokedApnsDevices(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
): Promise<void> {
  await tx`
    delete from apns_devices
     where organization_id = ${organizationId} and user_id = ${userId} and revoked_at is not null
  `;
}

/** Re-arms an existing registration with a fresh token; the 0108 trigger revokes any other holder of the hash. */
export async function updateApnsDevice(
  tx: TransactionDb,
  id: string,
  write: ApnsDeviceWrite,
): Promise<ApnsDeviceStateRow> {
  const rows = await tx<ApnsDeviceStateRow[]>`
    update apns_devices
       set bundle_id = ${write.bundleId}, environment = ${write.environment},
           token_hash = ${write.tokenHash}, token_ciphertext = ${write.token.ciphertext},
           token_nonce = ${write.token.nonce}, token_tag = ${write.token.tag},
           token_key_id = ${write.tokenKeyId}, revoked_at = null, revoked_reason = null,
           last_registered_at = now(), updated_at = now()
     where id = ${id} and organization_id = ${write.organizationId} and user_id = ${write.userId}
    returning id, revoked_at is null as enabled, last_registered_at as "lastRegisteredAt"
  `;
  const row = rows[0];
  if (!row) throw new Error("APNs device update matched no row.");
  return row;
}

export async function insertApnsDevice(
  tx: TransactionDb,
  write: ApnsDeviceWrite,
): Promise<ApnsDeviceStateRow> {
  const rows = await tx<ApnsDeviceStateRow[]>`
    insert into apns_devices (
      organization_id, user_id, installation_id, bundle_id, environment,
      token_hash, token_ciphertext, token_nonce, token_tag, token_key_id
    ) values (
      ${write.organizationId}, ${write.userId}, ${write.installationId}, ${write.bundleId},
      ${write.environment}, ${write.tokenHash}, ${write.token.ciphertext}, ${write.token.nonce},
      ${write.token.tag}, ${write.tokenKeyId}
    )
    returning id, revoked_at is null as enabled, last_registered_at as "lastRegisteredAt"
  `;
  const row = rows[0];
  if (!row) throw new Error("APNs device insert returned no row.");
  return row;
}

export async function deleteApnsDevice(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  installationId: string,
): Promise<number> {
  const rows = await tx<Array<{ id: string }>>`
    delete from apns_devices
     where organization_id = ${organizationId} and user_id = ${userId}
       and installation_id = ${installationId}
    returning id
  `;
  return rows.length;
}

// ------------------------------------------------------------------ worker ---

/**
 * Devices that should receive one outbox row (worker, inside `withTenant`):
 * active, of a live member, registered before the transition, and only while
 * the transition is younger than 24 h.
 */
export async function listFanoutApnsDevices(
  tx: TransactionDb,
  organizationId: string,
  outboxId: string,
): Promise<Array<{ id: string }>> {
  return tx<Array<{ id: string }>>`
    select d.id
      from apns_devices d
      join memberships m on m.organization_id = d.organization_id and m.user_id = d.user_id
      join push_outbox o on o.organization_id = d.organization_id and o.id = ${outboxId}
     where d.organization_id = ${organizationId} and d.revoked_at is null
       and m.revoked_at is null
       and d.created_at <= o.created_at
       and o.created_at > now() - interval '24 hours'
     order by d.created_at, d.id
  `;
}

/** Reserves one delivery per (outbox row, device); a replayed fan-out inserts nothing. */
export async function reserveApnsDeliveries(
  db: Db | TransactionDb,
  organizationId: string,
  outboxId: string,
  deviceIds: readonly string[],
): Promise<number> {
  let reserved = 0;
  for (const deviceId of deviceIds) {
    const rows = await db<Array<{ id: string }>>`
      insert into apns_deliveries (organization_id, outbox_id, device_id)
      values (${organizationId}, ${outboxId}, ${deviceId})
      on conflict (outbox_id, device_id) do nothing
      returning id
    `;
    reserved += rows.length;
  }
  return reserved;
}

export type ClaimedApnsDelivery = {
  id: string;
  organizationId: string;
  deviceId: string;
  attempts: number;
  workflowId: string;
  notificationSequence: number;
  eventType: string;
  botName: string;
  workflowKind: "dm" | "group" | "routine" | null;
  threadId: string | null;
  groupName: string | null;
};

/**
 * Claims one due delivery: pending and available, or `sending` with an
 * expired lease (a worker died mid-send). The lease and the attempt counter
 * move in the same statement, so a crash loop still ends at `maxAttempts`.
 */
export async function claimApnsDelivery(
  db: Db,
  input: { workerId: string; leaseSeconds: number; maxAttempts: number },
): Promise<ClaimedApnsDelivery | null> {
  const claimed = await db.begin(async (tx) => {
    const rows = await tx<ClaimedApnsDelivery[]>`
      with candidate as (
        select id from apns_deliveries
         where attempts < ${input.maxAttempts}
           and (
             (status = 'pending' and available_at <= now())
             or (status = 'sending' and lease_expires_at <= now())
           )
         order by available_at, created_at
         for update skip locked
         limit 1
      )
      update apns_deliveries delivery
         set status = 'sending', lease_owner = ${input.workerId},
             lease_expires_at = now() + (${input.leaseSeconds} * interval '1 second'),
             attempts = delivery.attempts + 1, updated_at = now()
        from candidate, push_outbox outbox
       where delivery.id = candidate.id
         and outbox.organization_id = delivery.organization_id and outbox.id = delivery.outbox_id
      returning delivery.id, delivery.organization_id as "organizationId",
                delivery.device_id as "deviceId", delivery.attempts,
                outbox.workflow_id as "workflowId",
                outbox.notification_sequence as "notificationSequence",
                outbox.event_type as "eventType", outbox.bot_name as "botName",
                (select w.kind from workflows w
                  where w.organization_id = outbox.organization_id and w.id = outbox.workflow_id) as "workflowKind",
                (select w.thread_id from workflows w
                  where w.organization_id = outbox.organization_id and w.id = outbox.workflow_id) as "threadId",
                (select g.name from workflows w
                   join threads th on th.organization_id = w.organization_id and th.id = w.thread_id
                   join bot_groups g on g.organization_id = th.organization_id and g.id = th.group_id
                  where w.organization_id = outbox.organization_id and w.id = outbox.workflow_id) as "groupName"
    `;
    return rows[0] ?? null;
  }) as ClaimedApnsDelivery | null;
  if (!claimed) return null;
  return { ...claimed, notificationSequence: Number(claimed.notificationSequence) };
}

/** `sending` rows whose lease died on their last allowed attempt: recorded as failed, never re-sent. */
export async function abandonExhaustedApnsDeliveries(db: Db, maxAttempts: number): Promise<number> {
  const rows = await db<Array<{ id: string }>>`
    update apns_deliveries
       set status = 'failed', lease_owner = null, lease_expires_at = null,
           last_reason = 'LeaseExpired', updated_at = now()
     where status = 'sending' and lease_expires_at <= now() and attempts >= ${maxAttempts}
    returning id
  `;
  return rows.length;
}

export type ApnsDeviceSecretRow = {
  id: string;
  bundleId: string;
  environment: ApnsEnvironment;
  revoked: boolean;
  memberActive: boolean;
  /** Version of the token read here; a revocation only applies to this one. */
  tokenHash: string;
  ciphertext: string | null;
  nonce: string | null;
  tag: string | null;
  keyId: string | null;
};

/** The encrypted token of one device (worker, inside `withTenant`); `null` when the device is gone. */
export async function readApnsDeviceSecret(
  tx: TransactionDb,
  organizationId: string,
  deviceId: string,
): Promise<ApnsDeviceSecretRow | null> {
  const rows = await tx<ApnsDeviceSecretRow[]>`
    select d.id, d.bundle_id as "bundleId", d.environment,
           d.revoked_at is not null as revoked,
           exists (select 1 from memberships m
                    where m.organization_id = d.organization_id and m.user_id = d.user_id
                      and m.revoked_at is null) as "memberActive",
           d.token_hash as "tokenHash", d.token_ciphertext as ciphertext, d.token_nonce as nonce,
           d.token_tag as tag, d.token_key_id as "keyId"
      from apns_devices d
     where d.organization_id = ${organizationId} and d.id = ${deviceId}
  `;
  return rows[0] ?? null;
}

/**
 * Revokes a device Apple declared dead; its secret is erased in the same
 * write. Only while the row still holds the token that was sent: a token
 * re-registered on the same installation during the APNs call stays active.
 */
export async function revokeApnsDevice(
  tx: TransactionDb,
  organizationId: string,
  deviceId: string,
  sentTokenHash: string,
  reason: ApnsRevocationReason,
): Promise<boolean> {
  const rows = await tx<Array<{ id: string }>>`
    update apns_devices
       set revoked_at = now(), revoked_reason = ${reason}, token_ciphertext = null,
           token_nonce = null, token_tag = null, token_key_id = null, updated_at = now()
     where organization_id = ${organizationId} and id = ${deviceId} and revoked_at is null
       and token_hash = ${sentTokenHash}
    returning id
  `;
  return rows.length > 0;
}

export async function touchApnsDevice(tx: TransactionDb, organizationId: string, deviceId: string): Promise<void> {
  await tx`
    update apns_devices set last_sent_at = now()
     where organization_id = ${organizationId} and id = ${deviceId}
  `;
}

export type ApnsDeliveryFinal = "sent" | "failed" | "revoked";

/** Final state of a claimed delivery; fenced by the lease owner so a stale worker cannot overwrite. */
export async function finishApnsDelivery(
  db: Db,
  input: {
    id: string;
    workerId: string;
    status: ApnsDeliveryFinal;
    httpStatus: number | null;
    reason: string | null;
  },
): Promise<boolean> {
  const rows = await db<Array<{ id: string }>>`
    update apns_deliveries
       set status = ${input.status}, lease_owner = null, lease_expires_at = null,
           last_http_status = ${input.httpStatus}, last_reason = ${input.reason},
           sent_at = case when ${input.status}::text = 'sent' then now() else sent_at end,
           updated_at = now()
     where id = ${input.id} and lease_owner = ${input.workerId} and status = 'sending'
    returning id
  `;
  return rows.length > 0;
}

/** Puts a claimed delivery back with a delay; the attempt counter already moved at claim time. */
export async function retryApnsDelivery(
  db: Db,
  input: {
    id: string;
    workerId: string;
    delaySeconds: number;
    httpStatus: number | null;
    reason: string | null;
  },
): Promise<boolean> {
  const rows = await db<Array<{ id: string }>>`
    update apns_deliveries
       set status = 'pending', lease_owner = null, lease_expires_at = null,
           available_at = now() + (${input.delaySeconds} * interval '1 second'),
           last_http_status = ${input.httpStatus}, last_reason = ${input.reason},
           updated_at = now()
     where id = ${input.id} and lease_owner = ${input.workerId} and status = 'sending'
    returning id
  `;
  return rows.length > 0;
}
