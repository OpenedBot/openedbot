/// <reference path="../web-push.d.ts" />
import type { SQL } from "bun";
import { Agent } from "node:https";
import { connectorUpgradePushPayload, isPushEventType, webPushPayload, type PushEventType } from "../domain/push-payload";
import { normalizeLocale, type Locale } from "@openedbot/contracts-locale";
import type { VapidConfig } from "@openedbot/platform-integrations/vapid";
import type { ApnsConfig } from "@openedbot/platform-integrations/apns";
import { fanOutApnsDeliveries } from "./apns-deliveries";

const LOOPBACK_AGENT = new Agent({ rejectUnauthorized: false });

const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 5;
const BATCH = 10;
const MAX_ERROR_LENGTH = 500;
/** An outdated connector notice older than this is marked skipped, not pushed late. */
const CONNECTOR_NOTICE_PUSH_WINDOW_HOURS = 24;

export type PushTransportResult = { statusCode: number };

export type PushTransport = {
  send(input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    payload: string;
  }): Promise<PushTransportResult>;
};

type OutboxRow = {
  id: string;
  organizationId: string;
  /** URL segment of push links; `null` only if the organization row is gone. */
  organizationSlug?: string | null;
  workflowId: string;
  notificationSequence: number;
  eventType: string;
  botId: string | null;
  botName: string;
  attempts: number;
};

type SubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  locale: string;
};

/**
 * Bibliothèque `web-push` plutôt qu'une implémentation VAPID maison : le
 * record `aes128gcm` (RFC 8291) et le JWT ES256 (RFC 8292) sont faciles à
 * rater, et les tests injectent un transport simulé : aucun réseau.
 */
export function createWebPushTransport(vapid: VapidConfig): PushTransport {
  return {
    async send(input) {
      const webpush = await loadWebPush();
      webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
      try {
        const loopback = isLoopbackPushEndpoint(input.endpoint);
        const result = await webpush.sendNotification(
          {
            endpoint: input.endpoint,
            keys: { p256dh: input.p256dh, auth: input.auth },
          },
          input.payload,
          { TTL: 86_400, urgency: "normal", ...(loopback ? { agent: LOOPBACK_AGENT } : {}) },
        );
        return { statusCode: result.statusCode };
      } catch (error) {
        const statusCode = webPushStatus(error);
        if (statusCode !== null) return { statusCode };
        throw error;
      }
    },
  };
}

/**
 * Drains `push_outbox` toward its two transports: Web Push (VAPID) is sent
 * here, APNs (DEV-308) only gets its per-device deliveries reserved here and
 * is sent by `processApnsDeliveries`, which owns its own retries. With
 * neither transport configured the pass is a no-op and the outbox waits.
 */
export async function processPushNotifications(
  db: SQL,
  config: { vapid: VapidConfig | null; apns?: ApnsConfig | null; workerId: string },
  transport: PushTransport | null = null,
): Promise<{ processed: number; delivered: number; gone: number }> {
  const apnsEnabled = Boolean(config.apns);
  if (!config.vapid && !apnsEnabled) return { processed: 0, delivered: 0, gone: 0 };
  const sender = config.vapid ? transport ?? createWebPushTransport(config.vapid) : null;
  let processed = 0;
  let delivered = 0;
  let gone = 0;
  for (let i = 0; i < BATCH; i += 1) {
    const outcome = await processOneOutbox(db, config.workerId, sender, apnsEnabled);
    if (outcome === "idle") break;
    processed += 1;
    delivered += outcome.delivered;
    gone += outcome.gone;
  }
  // Connector notices are a Web Push only channel (the e-mail is durable).
  if (!sender) return { processed, delivered, gone };
  for (let i = 0; i < BATCH; i += 1) {
    const outcome = await processOneConnectorNotice(db, sender);
    if (outcome === "idle") break;
    processed += 1;
    delivered += outcome.delivered;
    gone += outcome.gone;
  }
  return { processed, delivered, gone };
}

type ConnectorNoticeRow = {
  id: string;
  organizationId: string;
  organizationSlug: string | null;
  runtimeName: string | null;
  installedVersion: string;
  targetVersion: string;
  pushStatus: "sending" | "skipped";
};

/**
 * Outdated connector notices (0101), written by the link gateway: one web push
 * per subscription of an active organization owner. At most once: the claim
 * moves the notice out of `pending` before any send, so a crash or a failed
 * delivery never pushes it twice. The e-mail is the durable channel.
 */
async function processOneConnectorNotice(
  db: SQL,
  transport: PushTransport,
): Promise<"idle" | { delivered: number; gone: number }> {
  const claimed = await db.begin(async (tx) => {
    const rows = await tx<ConnectorNoticeRow[]>`
      with notice as (
        select id from runtime_connector_notices
         where push_status = 'pending'
         order by created_at asc
         for update skip locked
         limit 1
      )
      update runtime_connector_notices n
         set push_status = case
               when n.created_at > now() - make_interval(hours => ${CONNECTOR_NOTICE_PUSH_WINDOW_HOURS}::int)
                 then 'sending' else 'skipped' end,
             push_processed_at = now()
        from notice
       where n.id = notice.id
       returning n.id, n.organization_id as "organizationId",
                 n.installed_version as "installedVersion", n.target_version as "targetVersion",
                 n.push_status as "pushStatus",
                 (select o.slug from organizations o where o.id = n.organization_id) as "organizationSlug",
                 (select r.name from runtimes r where r.id = n.runtime_id) as "runtimeName"
    `;
    return rows[0] ?? null;
  }) as ConnectorNoticeRow | null;

  if (!claimed) return "idle";
  if (claimed.pushStatus !== "sending") return { delivered: 0, gone: 0 };

  const subscriptions = await db<SubscriptionRow[]>`
    select s.id, s.endpoint, s.p256dh, s.auth, s.locale
      from push_subscriptions s
      join memberships m on m.organization_id = s.organization_id and m.user_id = s.user_id
     where s.organization_id = ${claimed.organizationId} and s.failed_at is null
       and m.role = 'owner' and m.revoked_at is null
  `;
  let delivered = 0;
  let gone = 0;
  for (const subscription of subscriptions) {
    const payload = JSON.stringify(connectorUpgradePushPayload({
      runtimeName: claimed.runtimeName,
      installedVersion: claimed.installedVersion,
      targetVersion: claimed.targetVersion,
      locale: localeOf(subscription.locale),
      workspace: claimed.organizationSlug ?? claimed.organizationId,
    }));
    try {
      const result = await transport.send({
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        payload,
      });
      if (result.statusCode === 404 || result.statusCode === 410) {
        await db`delete from push_subscriptions where id = ${subscription.id}`;
        gone += 1;
        continue;
      }
      if (result.statusCode < 200 || result.statusCode >= 300) continue;
      await db`
        update push_subscriptions set last_used_at = now()
         where id = ${subscription.id}
      `;
      delivered += 1;
    } catch (error) {
      console.error(JSON.stringify({
        event: "worker.connector_notice_push_failed",
        organizationId: claimed.organizationId,
        subscriptionId: subscription.id,
        error: String(error),
      }));
    }
  }
  await db`
    update runtime_connector_notices
       set push_status = ${delivered > 0 ? "sent" : "skipped"}, push_processed_at = now()
     where id = ${claimed.id}
  `;
  return { delivered, gone };
}

async function processOneOutbox(
  db: SQL,
  workerId: string,
  transport: PushTransport | null,
  apnsEnabled: boolean,
): Promise<"idle" | { delivered: number; gone: number }> {
  const claimed = await db.begin(async (tx) => {
    const rows = await tx<OutboxRow[]>`
      with candidate as (
        select id from push_outbox
         where attempts < ${MAX_ATTEMPTS}
           and (
             (status = 'pending' and available_at <= now())
             or (status = 'sending' and lease_expires_at <= now())
           )
         order by created_at asc
         for update skip locked
         limit 1
      )
      update push_outbox outbox
         set status = 'sending', lease_owner = ${workerId},
             lease_expires_at = now() + (${LEASE_SECONDS} * interval '1 second'),
             attempts = outbox.attempts + 1, last_error = null
        from candidate
       where outbox.id = candidate.id
       returning outbox.id, outbox.organization_id as "organizationId",
                 outbox.workflow_id as "workflowId",
                 outbox.notification_sequence as "notificationSequence",
                 outbox.event_type as "eventType", outbox.bot_id as "botId",
                 outbox.bot_name as "botName", outbox.attempts,
                 (select o.slug from organizations o where o.id = outbox.organization_id) as "organizationSlug"
    `;
    return rows[0] ?? null;
  }) as OutboxRow | null;

  if (!claimed) return "idle";
  if (!isPushEventType(claimed.eventType)) {
    await markOutbox(db, claimed.id, workerId, "skipped", "Type d'événement inattendu.");
    return { delivered: 0, gone: 0 };
  }
  // Éditeur d'agent (0099) : « Notifier quand ce bot a fini » coupé, la fin
  // de ses workflows ne sonne plus. Une demande d'approbation sonne toujours :
  // elle bloque le travail tant que personne n'y répond.
  if (claimed.botId && claimed.eventType !== "approval.requested") {
    const muted = await db<Array<{ muted: boolean }>>`
      select not notify_on_finish as muted from bots
       where organization_id = ${claimed.organizationId} and id = ${claimed.botId}
    `;
    if (muted[0]?.muted) {
      await markOutbox(db, claimed.id, workerId, "skipped", null);
      return { delivered: 0, gone: 0 };
    }
  }

  // APNs first: its deliveries are reserved (idempotently) before any Web
  // Push send, so a crash in the loop below never loses the iOS fan-out.
  const apnsDevices = apnsEnabled ? await fanOutApnsDeliveries(db, claimed.organizationId, claimed.id) : 0;
  const subscriptions = transport ? await db<SubscriptionRow[]>`
    select id, endpoint, p256dh, auth, locale
      from push_subscriptions
     where organization_id = ${claimed.organizationId} and failed_at is null
  ` : [];
  if (!transport || subscriptions.length === 0) {
    await markOutbox(db, claimed.id, workerId, apnsDevices > 0 ? "sent" : "skipped", null);
    return { delivered: 0, gone: 0 };
  }

  let delivered = 0;
  let gone = 0;
  let retryable = false;
  for (const subscription of subscriptions) {
    const reserved = await db<Array<{ id: string }>>`
      insert into push_deliveries (
        organization_id, workflow_id, notification_sequence, subscription_id, status
      ) values (
        ${claimed.organizationId}, ${claimed.workflowId}, ${claimed.notificationSequence},
        ${subscription.id}, 'pending'
      ) on conflict (workflow_id, notification_sequence, subscription_id) do nothing
      returning id
    `;
    if (!reserved[0]) continue;

    const payload = JSON.stringify(webPushPayload({
      workspace: claimed.organizationSlug ?? claimed.organizationId,
      botName: claimed.botName,
      eventType: claimed.eventType as PushEventType,
      botId: claimed.botId,
      locale: localeOf(subscription.locale),
    }));

    try {
      const result = await transport.send({
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        payload,
      });
      if (result.statusCode === 404 || result.statusCode === 410) {
        await db`
          delete from push_subscriptions where id = ${subscription.id}
        `;
        gone += 1;
        continue;
      }
      if (result.statusCode < 200 || result.statusCode >= 300) {
        await db`delete from push_deliveries where id = ${reserved[0].id}`;
        retryable = true;
        continue;
      }
      await db`
        update push_deliveries set status = 'sent', sent_at = now()
         where id = ${reserved[0].id}
      `;
      await db`
        update push_subscriptions set last_used_at = now()
         where id = ${subscription.id}
      `;
      delivered += 1;
    } catch (error) {
      await db`delete from push_deliveries where id = ${reserved[0].id}`;
      retryable = true;
      console.error(JSON.stringify({
        event: "worker.push_delivery_failed",
        organizationId: claimed.organizationId,
        subscriptionId: subscription.id,
        error: String(error),
      }));
    }
  }

  if (retryable) {
    await db`
      update push_outbox set status = 'pending', lease_owner = null, lease_expires_at = null,
        available_at = now() + interval '30 seconds',
        last_error = ${"Livraison partielle, nouvel essai."}
       where id = ${claimed.id} and lease_owner = ${workerId}
    `;
  } else {
    await markOutbox(db, claimed.id, workerId, "sent", null);
  }
  return { delivered, gone };
}

async function markOutbox(
  db: SQL,
  id: string,
  workerId: string,
  status: "sent" | "skipped" | "failed",
  lastError: string | null,
): Promise<void> {
  const error = lastError ? lastError.slice(0, MAX_ERROR_LENGTH) : null;
  await db`
    update push_outbox set status = ${status}, lease_owner = null, lease_expires_at = null,
      last_error = ${error}
     where id = ${id} and lease_owner = ${workerId}
  `;
}

function localeOf(value: string): Locale {
  return normalizeLocale(value);
}

function isLoopbackPushEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function webPushStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && Number.isSafeInteger(status) ? status : null;
}

type WebPushModule = {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options?: { TTL?: number; urgency?: string; agent?: Agent },
  ): Promise<{ statusCode: number }>;
};

async function loadWebPush(): Promise<WebPushModule> {
  const loaded = await import("web-push") as { default?: WebPushModule } & WebPushModule;
  return loaded.default ?? loaded;
}
