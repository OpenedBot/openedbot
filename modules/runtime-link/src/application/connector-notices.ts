import type { TransactionDb } from "@openedbot/platform-db";

/**
 * Tell the organization owners, once, that a connector must be updated.
 *
 * The gateway calls this after admission when the announced agent is below
 * `RUNTIME_CONNECTOR_MIN_VERSION`. openedbot never updates a customer host: the
 * message only names `sudo edge-setup upgrade --yes`.
 *
 * Runs under `withTenant` as `openedbot_api`, which may insert into
 * `runtime_connector_notices` and `email_outbox` but read neither back (0064,
 * 0101). Hence `on conflict do nothing` without a target and no `returning`:
 * the written row count says whether the notice is new. The notice row and the
 * e-mails share the caller's transaction, so a failed e-mail insert leaves no
 * notice behind and the next connection tries again. The worker fans the web
 * push out from the notice row (`processPushNotifications`).
 */
export const RUNTIME_CONNECTOR_OUTDATED_EMAIL_KIND = "runtime_connector_outdated" as const;
const DEFAULT_LOCALE = "fr";

export type ConnectorUpgradeNotice = {
  organizationId: string;
  runtimeId: string;
  installedVersion: string;
  targetVersion: string;
  latestVersion: string | null;
  upgradeCommand: string;
};

export type ConnectorUpgradeNoticeResult = { queued: boolean; emails: number };

export async function enqueueConnectorUpgradeNotice(
  tx: TransactionDb,
  notice: ConnectorUpgradeNotice,
  webAppUrl: string,
): Promise<ConnectorUpgradeNoticeResult> {
  const written = await tx`
    insert into runtime_connector_notices (organization_id, runtime_id, installed_version, target_version)
    values (${notice.organizationId}, ${notice.runtimeId}, ${notice.installedVersion}, ${notice.targetVersion})
    on conflict do nothing
  `;
  if (!(written.count > 0)) return { queued: false, emails: 0 };

  const context = await tx<Array<{ runtimeName: string; workspace: string }>>`
    select r.name as "runtimeName", o.slug as workspace
      from runtimes r
      join organizations o on o.id = r.organization_id
     where r.id = ${notice.runtimeId} and r.organization_id = ${notice.organizationId}
  `;
  const owners = await tx<Array<{ userId: string; email: string }>>`
    select u.id as "userId", u.email
      from memberships m
      join users u on u.id = m.user_id
     where m.organization_id = ${notice.organizationId}
       and m.role = 'owner' and m.revoked_at is null
       and u.email is not null
  `;
  const payload = connectorUpgradeEmailPayload(
    notice,
    context[0]?.runtimeName ?? null,
    context[0]?.workspace ?? notice.organizationId,
    webAppUrl,
  );
  let emails = 0;
  for (const owner of owners) {
    const dedupeKey = [
      RUNTIME_CONNECTOR_OUTDATED_EMAIL_KIND,
      notice.runtimeId,
      notice.installedVersion,
      notice.targetVersion,
      owner.userId,
    ].join(":");
    const inserted = await tx`
      insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload)
      values (
        ${crypto.randomUUID()}, ${RUNTIME_CONNECTOR_OUTDATED_EMAIL_KIND}, ${dedupeKey},
        ${owner.email}, ${DEFAULT_LOCALE}, ${payload}::jsonb
      )
      on conflict do nothing
    `;
    if (inserted.count > 0) emails += 1;
  }
  return { queued: true, emails };
}

/** Payload of the `runtime_connector_outdated` template: no token, no IP address. */
export function connectorUpgradeEmailPayload(
  notice: Pick<ConnectorUpgradeNotice, "installedVersion" | "targetVersion" | "latestVersion" | "upgradeCommand">,
  runtimeName: string | null,
  workspace: string,
  webAppUrl: string,
): Record<string, unknown> {
  const origin = webAppUrl.replace(/\/+$/, "");
  return {
    runtimeName,
    installedVersion: notice.installedVersion,
    targetVersion: notice.targetVersion,
    latestVersion: notice.latestVersion,
    upgradeCommand: notice.upgradeCommand,
    settingsUrl: `${origin}/o/${encodeURIComponent(workspace)}/settings/runtime`,
    webAppUrl: origin,
  };
}
