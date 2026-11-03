import type { SQL } from "bun";

/**
 * Les e-mails du mode YOLO que le lien dépose lui-même (link-yolo.ts). À part
 * de `link-alerts.ts` (passe du worker, canaux d'alerte) : le link-gateway
 * n'embarque que ce fichier (apps/link-gateway/tests/link-gateway-closure.test.ts).
 */
export const YOLO_AUDIT_QUARANTINED_EMAIL_KIND = "yolo_audit_quarantined" as const;
const DEFAULT_LOCALE = "fr";

/**
 * Une tranche `yolo.audit` mise en quarantaine (`link-yolo.ts`) : les owners et
 * admins l'apprennent, dans la transaction même qui la garde. Le lien écrit en
 * `ohb_api` sous le tenant de l'organisation, qui dépose dans `email_outbox`
 * sans le relire (0064) : `on conflict do nothing` sans cible et sans
 * `returning`, comme `connector-notices.ts`. Une fois par quarantaine et par
 * destinataire ; jamais d'argument ni de hash dans le message.
 */
export async function enqueueYoloAuditQuarantineEmails(
  tx: SQL,
  quarantine: { id: string; organizationId: string; runtimeName: string; reason: string; fromSeq: number; toSeq: number; receivedAt: Date },
  webAppUrl: string,
): Promise<number> {
  const recipients = await tx<Array<{ userId: string; email: string }>>`
    select u.id as "userId", u.email
      from memberships m
      join users u on u.id = m.user_id
     where m.organization_id = ${quarantine.organizationId}
       and m.role in ('owner', 'admin') and m.revoked_at is null
       and u.email is not null
  `;
  const origin = webAppUrl.replace(/\/+$/, "");
  const workspace = origin ? await workspaceSlug(tx, quarantine.organizationId) : "";
  const payload = {
    runtimeName: quarantine.runtimeName,
    reason: quarantine.reason,
    fromSeq: quarantine.fromSeq,
    toSeq: quarantine.toSeq,
    receivedAt: quarantine.receivedAt.toISOString(),
    ...(origin ? { settingsUrl: `${origin}/o/${encodeURIComponent(workspace)}/settings/runtime`, webAppUrl: origin } : {}),
  };
  let inserted = 0;
  for (const recipient of recipients) {
    const written = await tx`
      insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload)
      values (${crypto.randomUUID()}, ${YOLO_AUDIT_QUARANTINED_EMAIL_KIND},
              ${`${YOLO_AUDIT_QUARANTINED_EMAIL_KIND}:${quarantine.id}:${recipient.userId}`},
              ${recipient.email}, ${DEFAULT_LOCALE}, ${payload}::jsonb)
      on conflict do nothing
    `;
    if (written.count > 0) inserted += 1;
  }
  return inserted;
}

/** Le slug d'espace des liens d'un e-mail ; l'identifiant quand il n'y en a pas. */
export async function workspaceSlug(tx: SQL, organizationId: string): Promise<string> {
  const organization = await tx<Array<{ slug: string }>>`
    select slug from organizations where id = ${organizationId}
  `;
  return organization[0]?.slug ?? organizationId;
}
