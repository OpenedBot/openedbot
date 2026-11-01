import type { Db, TransactionDb } from "@openedbot/platform-db";
import type { AlertChannelKind, AlertDeliveryEvent, AlertFailureReason } from "../domain/alert-channels";

/**
 * SQL des canaux d'alerte (0157). Les fonctions « canal » tournent sous
 * `withTenant` (API ou worker) : `alert_channels` porte un secret et sa RLS
 * suit `app.organization_id`. Les fonctions « livraison » sont la file du
 * worker, qui traverse les organisations sans secret.
 */

export type AlertChannelRow = {
  id: string;
  kind: AlertChannelKind;
  label: string;
  targetHint: string;
  enabled: boolean;
  createdAt: Date | string;
  lastDeliveredAt: Date | string | null;
  lastFailureAt: Date | string | null;
  lastFailureStatus: number | null;
  lastFailureReason: AlertFailureReason | null;
  lastTestAt: Date | string | null;
};

export async function listAlertChannels(tx: TransactionDb, organizationId: string): Promise<AlertChannelRow[]> {
  return tx<AlertChannelRow[]>`
    select id, kind, label, target_hint as "targetHint", enabled, created_at as "createdAt",
           last_delivered_at as "lastDeliveredAt", last_failure_at as "lastFailureAt",
           last_failure_status as "lastFailureStatus", last_failure_reason as "lastFailureReason",
           last_test_at as "lastTestAt"
      from alert_channels
     where organization_id = ${organizationId}
     order by created_at, id
  `;
}

export async function readAlertChannel(tx: TransactionDb, organizationId: string, id: string): Promise<AlertChannelRow | null> {
  const rows = await tx<AlertChannelRow[]>`
    select id, kind, label, target_hint as "targetHint", enabled, created_at as "createdAt",
           last_delivered_at as "lastDeliveredAt", last_failure_at as "lastFailureAt",
           last_failure_status as "lastFailureStatus", last_failure_reason as "lastFailureReason",
           last_test_at as "lastTestAt"
      from alert_channels
     where organization_id = ${organizationId} and id = ${id}
  `;
  return rows[0] ?? null;
}

/**
 * Le nombre de canaux de l'organisation, sous un verrou transactionnel par
 * organisation : deux ajouts simultanés ne dépassent pas la limite.
 */
export async function lockAndCountAlertChannels(tx: TransactionDb, organizationId: string): Promise<number> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`alert_channels:${organizationId}`}, 0))`;
  const rows = await tx<Array<{ count: number }>>`
    select count(*)::int as count from alert_channels where organization_id = ${organizationId}
  `;
  return rows[0]?.count ?? 0;
}

/** Le nouveau canal, ou `null` quand ce webhook est déjà déclaré dans l'organisation. */
export async function insertAlertChannel(
  tx: TransactionDb,
  input: {
    organizationId: string;
    kind: AlertChannelKind;
    label: string;
    targetHint: string;
    targetHash: string;
    secret: { ciphertext: string; nonce: string; tag: string; keyId: string };
    createdBy: string;
  },
): Promise<AlertChannelRow | null> {
  const rows = await tx<AlertChannelRow[]>`
    insert into alert_channels (
      organization_id, kind, label, target_hint, target_hash,
      secret_ciphertext, secret_nonce, secret_tag, secret_key_id, created_by
    ) values (
      ${input.organizationId}, ${input.kind}, ${input.label}, ${input.targetHint}, ${input.targetHash},
      ${input.secret.ciphertext}, ${input.secret.nonce}, ${input.secret.tag}, ${input.secret.keyId}, ${input.createdBy}
    )
    on conflict (organization_id, target_hash) do nothing
    returning id, kind, label, target_hint as "targetHint", enabled, created_at as "createdAt",
              last_delivered_at as "lastDeliveredAt", last_failure_at as "lastFailureAt",
              last_failure_status as "lastFailureStatus", last_failure_reason as "lastFailureReason",
              last_test_at as "lastTestAt"
  `;
  return rows[0] ?? null;
}

/**
 * Renomme ou (dés)active un canal. Le réactiver efface le dernier échec : le
 * geste dit « réessaie », et l'écran ne doit plus afficher l'ancienne panne.
 */
export async function updateAlertChannel(
  tx: TransactionDb,
  organizationId: string,
  id: string,
  patch: { enabled?: boolean; label?: string },
): Promise<AlertChannelRow | null> {
  const label = patch.label ?? null;
  const enabled = patch.enabled ?? null;
  const rows = await tx<AlertChannelRow[]>`
    update alert_channels
       set label = coalesce(${label}::text, label),
           enabled = coalesce(${enabled}::boolean, enabled),
           last_failure_at = case when ${enabled}::boolean and not enabled then null else last_failure_at end,
           last_failure_status = case when ${enabled}::boolean and not enabled then null else last_failure_status end,
           last_failure_reason = case when ${enabled}::boolean and not enabled then null else last_failure_reason end,
           updated_at = now()
     where organization_id = ${organizationId} and id = ${id}
    returning id, kind, label, target_hint as "targetHint", enabled, created_at as "createdAt",
              last_delivered_at as "lastDeliveredAt", last_failure_at as "lastFailureAt",
              last_failure_status as "lastFailureStatus", last_failure_reason as "lastFailureReason",
              last_test_at as "lastTestAt"
  `;
  return rows[0] ?? null;
}

export async function deleteAlertChannel(tx: TransactionDb, organizationId: string, id: string): Promise<boolean> {
  const rows = await tx<Array<{ id: string }>>`
    delete from alert_channels where organization_id = ${organizationId} and id = ${id} returning id
  `;
  return rows.length > 0;
}

export type AlertChannelSecretRow = {
  id: string;
  kind: AlertChannelKind;
  label: string;
  enabled: boolean;
  ciphertext: string;
  nonce: string;
  tag: string;
  keyId: string;
};

/** Le webhook chiffré d'un canal (sous `withTenant`) ; `null` quand le canal n'existe plus. */
export async function readAlertChannelSecret(
  tx: TransactionDb,
  organizationId: string,
  id: string,
): Promise<AlertChannelSecretRow | null> {
  const rows = await tx<AlertChannelSecretRow[]>`
    select id, kind, label, enabled,
           secret_ciphertext as ciphertext, secret_nonce as nonce,
           secret_tag as tag, secret_key_id as "keyId"
      from alert_channels
     where organization_id = ${organizationId} and id = ${id}
  `;
  return rows[0] ?? null;
}

/**
 * Réserve un test : `false` si le précédent date de moins de `cooldownSeconds`.
 * La réservation est écrite avant l'appel, donc un double clic n'envoie qu'un message.
 */
export async function reserveAlertChannelTest(
  tx: TransactionDb,
  organizationId: string,
  id: string,
  cooldownSeconds: number,
): Promise<boolean> {
  const rows = await tx<Array<{ id: string }>>`
    update alert_channels
       set last_test_at = now()
     where organization_id = ${organizationId} and id = ${id}
       and (last_test_at is null or last_test_at <= now() - (${cooldownSeconds} * interval '1 second'))
    returning id
  `;
  return rows.length > 0;
}

export type AlertChannelOutcome =
  | { delivered: true }
  | { delivered: false; reason: AlertFailureReason; httpStatus: number | null; disable: boolean };

/** Ce que le dernier envoi a donné, lisible dans Réglages. Un webhook révoqué désactive le canal. */
export async function recordAlertChannelOutcome(
  tx: TransactionDb,
  organizationId: string,
  id: string,
  outcome: AlertChannelOutcome,
): Promise<void> {
  if (outcome.delivered) {
    await tx`
      update alert_channels
         set last_delivered_at = now(), last_failure_at = null, last_failure_status = null,
             last_failure_reason = null, updated_at = now()
       where organization_id = ${organizationId} and id = ${id}
    `;
    return;
  }
  await tx`
    update alert_channels
       set last_failure_at = now(), last_failure_status = ${outcome.httpStatus},
           last_failure_reason = ${outcome.reason},
           enabled = case when ${outcome.disable}::boolean then false else enabled end,
           updated_at = now()
     where organization_id = ${organizationId} and id = ${id}
  `;
}

/**
 * Dépose le 🔴 d'une alerte de lien pour chaque canal actif de son
 * organisation, dans la transaction qui ouvre l'alerte. Idempotent par
 * (canal, alerte, événement). Le tenant est posé le temps de lire les canaux,
 * puis effacé : la passe d'alertes traverse les organisations.
 */
export async function enqueueRuntimeLinkDownDeliveries(
  tx: TransactionDb,
  input: { organizationId: string; alertId: string; payload: Record<string, unknown> },
): Promise<number> {
  await tx`select set_config('app.organization_id', ${input.organizationId}, true)`;
  try {
    const rows = await tx<Array<{ id: string }>>`
      insert into alert_deliveries (organization_id, channel_id, alert_id, event, payload)
      select c.organization_id, c.id, ${input.alertId}::uuid, 'runtime_link_down', ${input.payload}::jsonb
        from alert_channels c
       where c.organization_id = ${input.organizationId} and c.enabled
      on conflict (channel_id, alert_id, event) do nothing
      returning id
    `;
    return rows.length;
  } finally {
    await tx`select set_config('app.organization_id', '', true)`;
  }
}

/**
 * Dépose le 🟢 d'une alerte résolue par le retour du lien, vers les seuls
 * canaux qui ont reçu (ou reçoivent) son 🔴.
 *
 * Un 🔴 encore en attente (Discord en panne, recul en cours) est annulé
 * plutôt qu'envoyé en retard suivi d'un 🟢 : la panne est finie, personne n'a
 * à l'apprendre. Un 🔴 abandonné (`failed`) n'appelle pas non plus de 🟢.
 */
export async function enqueueRuntimeLinkRestoredDeliveries(
  tx: TransactionDb,
  input: { organizationId: string; alertId: string; payload: Record<string, unknown> },
): Promise<number> {
  await tx`
    update alert_deliveries
       set status = 'cancelled', last_reason = 'resolved_before_send', updated_at = now()
     where alert_id = ${input.alertId} and event = 'runtime_link_down' and status = 'pending'
  `;
  await tx`select set_config('app.organization_id', ${input.organizationId}, true)`;
  try {
    const rows = await tx<Array<{ id: string }>>`
      insert into alert_deliveries (organization_id, channel_id, alert_id, event, payload)
      select d.organization_id, d.channel_id, d.alert_id, 'runtime_link_restored', ${input.payload}::jsonb
        from alert_deliveries d
        join alert_channels c on c.organization_id = d.organization_id and c.id = d.channel_id
       where d.alert_id = ${input.alertId} and d.event = 'runtime_link_down'
         and d.status in ('sending', 'sent') and c.enabled
      on conflict (channel_id, alert_id, event) do nothing
      returning id
    `;
    return rows.length;
  } finally {
    await tx`select set_config('app.organization_id', '', true)`;
  }
}

export type ClaimedAlertDelivery = {
  id: string;
  organizationId: string;
  channelId: string;
  alertId: string;
  event: AlertDeliveryEvent;
  payload: Record<string, unknown>;
  attempts: number;
};

/**
 * Réclame la prochaine livraison due, bail compris. Un 🟢 attend que le 🔴
 * du même canal soit réglé : il n'arrive jamais avant lui.
 */
export async function claimAlertDelivery(
  db: Db,
  input: { workerId: string; leaseSeconds: number; maxAttempts: number },
): Promise<ClaimedAlertDelivery | null> {
  const rows = await db<ClaimedAlertDelivery[]>`
    with candidate as (
      select d.id from alert_deliveries d
       where d.attempts < ${input.maxAttempts}
         and (
           (d.status = 'pending' and d.available_at <= now())
           or (d.status = 'sending' and d.lease_expires_at <= now())
         )
         and not (
           d.event = 'runtime_link_restored' and exists (
             select 1 from alert_deliveries first
              where first.channel_id = d.channel_id and first.alert_id = d.alert_id
                and first.event = 'runtime_link_down' and first.status in ('pending', 'sending')
           )
         )
       order by d.available_at, d.created_at
       for update skip locked
       limit 1
    )
    update alert_deliveries delivery
       set status = 'sending', lease_owner = ${input.workerId},
           lease_expires_at = now() + (${input.leaseSeconds} * interval '1 second'),
           attempts = delivery.attempts + 1, updated_at = now()
      from candidate
     where delivery.id = candidate.id
    returning delivery.id, delivery.organization_id as "organizationId",
              delivery.channel_id as "channelId", delivery.alert_id as "alertId",
              delivery.event, delivery.payload, delivery.attempts
  `;
  return rows[0] ?? null;
}

/** Une livraison réclamée puis perdue (worker mort) au-delà du dernier essai. */
export async function abandonExhaustedAlertDeliveries(db: Db, maxAttempts: number): Promise<number> {
  const rows = await db<Array<{ id: string }>>`
    update alert_deliveries
       set status = 'failed', lease_owner = null, lease_expires_at = null,
           last_reason = 'lease_expired', updated_at = now()
     where status = 'sending' and lease_expires_at <= now() and attempts >= ${maxAttempts}
    returning id
  `;
  return rows.length;
}

export async function finishAlertDelivery(
  db: Db,
  input: {
    id: string;
    workerId: string;
    status: "sent" | "failed" | "cancelled";
    httpStatus: number | null;
    reason: string | null;
  },
): Promise<boolean> {
  const rows = await db<Array<{ id: string }>>`
    update alert_deliveries
       set status = ${input.status}, lease_owner = null, lease_expires_at = null,
           last_http_status = ${input.httpStatus}, last_reason = ${input.reason},
           sent_at = case when ${input.status}::text = 'sent' then now() else sent_at end,
           updated_at = now()
     where id = ${input.id} and lease_owner = ${input.workerId} and status = 'sending'
    returning id
  `;
  return rows.length > 0;
}

/** Remet une livraison réclamée en attente ; le compteur d'essais a bougé à la réclamation. */
export async function retryAlertDelivery(
  db: Db,
  input: { id: string; workerId: string; delaySeconds: number; httpStatus: number | null; reason: string },
): Promise<boolean> {
  const rows = await db<Array<{ id: string }>>`
    update alert_deliveries
       set status = 'pending', lease_owner = null, lease_expires_at = null,
           available_at = now() + (${input.delaySeconds} * interval '1 second'),
           last_http_status = ${input.httpStatus}, last_reason = ${input.reason},
           updated_at = now()
     where id = ${input.id} and lease_owner = ${input.workerId} and status = 'sending'
    returning id
  `;
  return rows.length > 0;
}
