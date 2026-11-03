import type { SQL } from "bun";
import { enqueueEmailReturningId } from "@openedbot/notifications/sql/email-outbox";
import {
  enqueueRuntimeLinkDownDeliveries,
  enqueueRuntimeLinkRestoredDeliveries,
} from "@openedbot/notifications/sql/alert-channels";

/**
 * Alertes de panne durable du lien connecteur, côté worker.
 *
 * Le broker et `sweepDisconnectedRuntimeLinks` disent déjà qu'un lien est
 * `disconnected` ; cette passe dit à QUI. Un runtime coupé depuis plus de
 * `downAfterMinutes` ouvre une alerte (une seule à la fois, index unique
 * partiel de 0087) et dépose l'e-mail `runtime_link_down` à l'utilisateur
 * concerné (le dernier à avoir appairé le runtime) et aux owners et admins de
 * l'organisation. Le retour du lien, une révocation ou une suppression la
 * résolvent ; seul le retour du lien, sur une alerte qui avait prévenu
 * quelqu'un, dépose `runtime_link_restored` aux mêmes destinataires.
 *
 * Un worker qui démarre ne juge aucun lien avant `downAfterMinutes` : après
 * une panne d'openedbot lui-même, tous les liens paraissent muets depuis la coupure
 * alors que les connectors reviennent en quelques secondes (le 2026-10-17,
 * l'hyperviseur a éteint le VPS : alerte envoyée à 13:42, lien revenu à 13:45).
 *
 * Une panne déjà vieille de plus de `RUNTIME_LINK_ALERT_EMAIL_WINDOW_HOURS`
 * quand l'alerte s'ouvre est enregistrée sans e-mail : au premier déploiement,
 * les postes éteints depuis des semaines ne partent pas en rafale.
 *
 * Les canaux d'alerte de l'organisation (Discord, 0157) suivent les mêmes
 * règles que l'e-mail : un 🔴 déposé avec l'e-mail, un 🟢 au retour du lien
 * vers les seuls canaux qui ont eu le 🔴. Le dépôt est dans la transaction de
 * l'alerte ; l'envoi est une autre passe (`processAlertDeliveries`), donc un
 * Discord en panne ne retient ni l'alerte ni l'e-mail.
 */
export const RUNTIME_LINK_DOWN_EMAIL_KIND = "runtime_link_down" as const;
export const RUNTIME_LINK_RESTORED_EMAIL_KIND = "runtime_link_restored" as const;
export const RUNTIME_LINK_ALERT_EMAIL_WINDOW_HOURS = 24;
const DEFAULT_LOCALE = "fr";

export type RuntimeLinkAlertOptions = {
  downAfterMinutes: number;
  /** Origine de la PWA : lien vers les réglages du runtime et liens légaux. */
  webAppUrl: string;
  /** Depuis quand ce processus observe les liens (son démarrage). Absent : aucun délai. */
  observingSince?: Date;
  /** Le palier de déploiement (dev, preprod, prod), nommé dans les messages des canaux. */
  environment: string;
};

export type RuntimeLinkAlertPass = {
  opened: number;
  resolved: number;
  emails: number;
  restoredEmails: number;
  /** Livraisons déposées vers les canaux d'alerte (🔴 et 🟢). */
  channelDeliveries: number;
};

type ResolvedAlert = {
  id: string;
  organizationId: string;
  runtimeName: string;
  downSince: Date | string;
  concernedUserId: string | null;
  notified: boolean;
  restored: boolean;
};

type OpenedAlert = {
  id: string;
  organizationId: string;
  runtimeName: string;
  reason: string | null;
  downSince: Date | string;
  concernedUserId: string | null;
  recent: boolean;
};

export async function evaluateRuntimeLinkAlerts(
  db: SQL,
  options: RuntimeLinkAlertOptions,
): Promise<RuntimeLinkAlertPass> {
  return db.begin(async (tx) => {
    const resolved = await tx<ResolvedAlert[]>`
      update runtime_link_alerts a
         set status = 'resolved', resolved_at = now()
       where a.status = 'open'
         and not exists (
           select 1 from runtimes r
            where r.id = a.runtime_id
              and r.reachability = 'connector'
              and r.revoked_at is null
              and r.last_health_status = 'disconnected'
         )
      returning a.id, a.organization_id as "organizationId", a.runtime_name as "runtimeName",
                a.down_since as "downSince", a.concerned_user_id as "concernedUserId",
                a.notified_at is not null as notified,
                exists (
                  select 1 from runtimes r
                   where r.id = a.runtime_id and r.reachability = 'connector' and r.revoked_at is null
                ) as restored
    `;
    const opened = await tx<OpenedAlert[]>`
      insert into runtime_link_alerts (organization_id, runtime_id, runtime_name, reason, down_since, concerned_user_id)
      select r.organization_id, r.id, r.name, r.last_health_error,
             coalesce(r.link_last_seen_at, r.updated_at),
             (select e.claimed_by
                from runtime_enrollments e
               where e.runtime_id = r.id and e.claimed_by is not null
               order by e.claimed_at desc nulls last
               limit 1)
        from runtimes r
       where r.reachability = 'connector'
         and r.revoked_at is null
         and r.last_health_status = 'disconnected'
         and coalesce(r.link_last_seen_at, r.updated_at) < now() - make_interval(mins => ${options.downAfterMinutes}::int)
         and ${options.observingSince ?? new Date(0)}::timestamptz < now() - make_interval(mins => ${options.downAfterMinutes}::int)
         and not exists (
           select 1 from runtime_link_alerts a where a.runtime_id = r.id and a.status = 'open'
         )
      on conflict do nothing
      returning id, organization_id as "organizationId", runtime_name as "runtimeName", reason,
                down_since as "downSince", concerned_user_id as "concernedUserId",
                down_since > now() - make_interval(hours => ${RUNTIME_LINK_ALERT_EMAIL_WINDOW_HOURS}::int) as recent
    `;
    let emails = 0;
    let channelDeliveries = 0;
    for (const alert of opened) {
      if (!alert.recent) continue;
      const sent = await enqueueRuntimeLinkDownEmails(tx, alert, options.webAppUrl);
      await tx`
        update runtime_link_alerts
           set notified_at = now(), notified_recipients = ${sent}
         where id = ${alert.id}
      `;
      emails += sent;
      channelDeliveries += await enqueueRuntimeLinkDownDeliveries(tx, {
        organizationId: alert.organizationId,
        alertId: alert.id,
        payload: { ...runtimeLinkDownEmailPayload(alert, await workspaceSlug(tx, alert.organizationId), options.webAppUrl), environment: options.environment },
      });
    }
    let restoredEmails = 0;
    for (const alert of resolved) {
      if (!alert.notified || !alert.restored) continue;
      const restoredAt = new Date();
      restoredEmails += await enqueueRuntimeLinkEmails(
        tx, RUNTIME_LINK_RESTORED_EMAIL_KIND, alert,
        (workspace) => runtimeLinkRestoredEmailPayload(alert, restoredAt, workspace, options.webAppUrl),
      );
      channelDeliveries += await enqueueRuntimeLinkRestoredDeliveries(tx, {
        organizationId: alert.organizationId,
        alertId: alert.id,
        payload: {
          ...runtimeLinkRestoredEmailPayload(alert, restoredAt, await workspaceSlug(tx, alert.organizationId), options.webAppUrl),
          environment: options.environment,
        },
      });
    }
    return { opened: opened.length, resolved: resolved.length, emails, restoredEmails, channelDeliveries };
  });
}

function enqueueRuntimeLinkDownEmails(tx: SQL, alert: OpenedAlert, webAppUrl: string): Promise<number> {
  return enqueueRuntimeLinkEmails(
    tx, RUNTIME_LINK_DOWN_EMAIL_KIND, alert,
    (workspace) => runtimeLinkDownEmailPayload(alert, workspace, webAppUrl),
  );
}

async function enqueueRuntimeLinkEmails(
  tx: SQL,
  kind: typeof RUNTIME_LINK_DOWN_EMAIL_KIND | typeof RUNTIME_LINK_RESTORED_EMAIL_KIND,
  alert: Pick<OpenedAlert, "id" | "organizationId" | "concernedUserId">,
  payloadFor: (workspace: string) => Record<string, unknown>,
): Promise<number> {
  const recipients = await tx<Array<{ userId: string; email: string }>>`
    select u.id as "userId", u.email
      from users u
     where u.email is not null
       and (
         u.id = ${alert.concernedUserId}
         or u.id in (
           select m.user_id from memberships m
            where m.organization_id = ${alert.organizationId}
              and m.role in ('owner', 'admin') and m.revoked_at is null
         )
       )
  `;
  const workspace = await workspaceSlug(tx, alert.organizationId);
  const payload = payloadFor(workspace);
  let inserted = 0;
  for (const recipient of recipients) {
    const queued = await enqueueEmailReturningId(tx, {
      kind,
      dedupeKey: `${kind}:${alert.id}:${recipient.userId}`,
      recipientEmail: recipient.email,
      locale: DEFAULT_LOCALE,
      payload,
    });
    if (queued) inserted += 1;
  }
  return inserted;
}

async function workspaceSlug(tx: SQL, organizationId: string): Promise<string> {
  const organization = await tx<Array<{ slug: string }>>`
    select slug from organizations where id = ${organizationId}
  `;
  return organization[0]?.slug ?? organizationId;
}

/** La charge utile du gabarit `runtime_link_down` : jamais de jeton ni d'adresse IP. */
export function runtimeLinkDownEmailPayload(
  alert: Pick<OpenedAlert, "runtimeName" | "reason" | "downSince">,
  workspace: string,
  webAppUrl: string,
): Record<string, unknown> {
  const origin = webAppUrl.replace(/\/+$/, "");
  return {
    runtimeName: alert.runtimeName,
    reason: alert.reason,
    downSince: new Date(alert.downSince).toISOString(),
    settingsUrl: `${origin}/o/${encodeURIComponent(workspace)}/settings/runtime`,
    webAppUrl: origin,
  };
}

/** La charge utile du gabarit `runtime_link_restored` : jamais de jeton ni d'adresse IP. */
export function runtimeLinkRestoredEmailPayload(
  alert: Pick<ResolvedAlert, "runtimeName" | "downSince">,
  restoredAt: Date,
  workspace: string,
  webAppUrl: string,
): Record<string, unknown> {
  const origin = webAppUrl.replace(/\/+$/, "");
  return {
    runtimeName: alert.runtimeName,
    downSince: new Date(alert.downSince).toISOString(),
    restoredAt: restoredAt.toISOString(),
    settingsUrl: `${origin}/o/${encodeURIComponent(workspace)}/settings/runtime`,
    webAppUrl: origin,
  };
}
