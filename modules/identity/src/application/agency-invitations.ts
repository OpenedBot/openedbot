import type { AgencyClientInvitationDto } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { hashCredential, randomCredential } from "@openedbot/platform-db/credential";
import { enqueueTransactionalEmail } from "@openedbot/notifications/application/transactional-email";
import { isEmailSyntaxValid, normalizeEmail } from "../domain/email-address";
import { assertWorkspaceId } from "../domain/workspace-access";
import { assertEmailDeliverable, defaultEmailDomainChecker } from "./email-deliverability";
import type { EmailDomainResolver } from "./email-domain-check";

export type AgencyInvitationActor = { organizationId: string; userId: string };
type InvitationRow = {
  id: string; email: string; status: AgencyClientInvitationDto["status"];
  expiresAt: Date; acceptedClientOrganizationId: string | null;
};
const dto = (row: InvitationRow): AgencyClientInvitationDto => ({ ...row, expiresAt: row.expiresAt.toISOString() });

async function assertInviter(tx: TransactionDb, actor: AgencyInvitationActor): Promise<string> {
  const organizations = await tx<Array<{ name: string }>>`select name from organizations
    where id = ${actor.organizationId} and kind = 'agency' and deleted_at is null for no key update`;
  const memberships = await tx`select role from memberships where organization_id = ${actor.organizationId}
    and user_id = ${actor.userId} and revoked_at is null and role in ('owner', 'admin')`;
  if (!organizations[0] || !memberships[0]) throw new HttpError(403, "AGENCY_INVITATION_FORBIDDEN", "Seuls les propriétaires et administrateurs de l'agence peuvent inviter un client.");
  return organizations[0].name;
}

export async function listAgencyInvitations(db: Db, actor: AgencyInvitationActor): Promise<AgencyClientInvitationDto[]> {
  return withTenant(db, actor.organizationId, async (tx) => {
    await assertInviter(tx, actor);
    await tx`update agency_client_invitations set status = 'expired'
      where agency_organization_id = ${actor.organizationId} and status = 'pending' and expires_at <= now()`;
    const rows = await tx<InvitationRow[]>`select id, email, status, expires_at as "expiresAt",
      accepted_client_organization_id as "acceptedClientOrganizationId" from agency_client_invitations
      where agency_organization_id = ${actor.organizationId} order by created_at desc, id limit 200`;
    return rows.map(dto);
  });
}

export async function sendAgencyInvitation(db: Db, actor: AgencyInvitationActor, input: {
  email?: unknown; invitationId?: string; webUrl: string; locale?: unknown;
}, checkDomain: EmailDomainResolver = defaultEmailDomainChecker()): Promise<AgencyClientInvitationDto> {
  const token = randomCredential(32);
  // A new address is proven deliverable before the transaction opens: the DNS
  // lookup can take up to three seconds and must not hold the agency lock.
  let requestedEmail: string | null = null;
  if (!input.invitationId) {
    if (typeof input.email !== "string" || !isEmailSyntaxValid(input.email)) throw new HttpError(400, "EMAIL_INVALID", "Adresse email invalide.");
    requestedEmail = normalizeEmail(input.email);
    await assertEmailDeliverable(requestedEmail, checkDomain, "agency_invitation");
  }
  return withTenant(db, actor.organizationId, async (tx) => {
    const agencyName = await assertInviter(tx, actor);
    const origin = new URL(input.webUrl).origin;
    let id: string = crypto.randomUUID();
    let email: string;
    if (input.invitationId) {
      id = assertWorkspaceId(input.invitationId);
      const existing = await tx<Array<{ email: string }>>`select email from agency_client_invitations
        where id = ${id} and agency_organization_id = ${actor.organizationId} and status in ('pending', 'expired') for update`;
      if (!existing[0]) throw new HttpError(409, "AGENCY_INVITATION_UNAVAILABLE", "Cette invitation ne peut plus être renvoyée.");
      email = existing[0].email;
      // The domain may have gone away since the first send.
      await assertEmailDeliverable(email, checkDomain, "agency_invitation");
    } else {
      email = requestedEmail!;
      await tx`update agency_client_invitations set status = 'expired' where agency_organization_id = ${actor.organizationId}
        and email = ${email} and status = 'pending' and expires_at <= now()`;
      const duplicates = await tx`select id from agency_client_invitations where agency_organization_id = ${actor.organizationId}
        and email = ${email} and status = 'pending'`;
      if (duplicates[0]) throw new HttpError(409, "AGENCY_INVITATION_PENDING", "Une invitation est déjà en attente pour cette adresse.");
    }
    const otherPending = await tx`select id from agency_client_invitations where agency_organization_id = ${actor.organizationId}
      and email = ${email} and status = 'pending' and id <> ${id}`;
    if (otherPending[0]) throw new HttpError(409, "AGENCY_INVITATION_PENDING", "Une invitation est déjà en attente pour cette adresse.");
    const tokenHash = hashCredential(token);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    if (input.invitationId) {
      await tx`update agency_client_invitations set token_hash = ${tokenHash}, expires_at = ${expiresAt}, status = 'pending',
        invited_by_user_id = ${actor.userId} where id = ${id} and agency_organization_id = ${actor.organizationId}`;
    } else {
      await tx`insert into agency_client_invitations (id, agency_organization_id, email, token_hash, invited_by_user_id, expires_at)
        values (${id}, ${actor.organizationId}, ${email}, ${tokenHash}, ${actor.userId}, ${expiresAt})`;
    }
    await enqueueTransactionalEmail(tx, {
      kind: "agency_client_invitation", dedupeKey: `agency-invitation:${id}:${tokenHash}`,
      recipientEmail: email, locale: input.locale === "en" ? "en" : "fr", payload: { agencyName, invitationUrl: `${origin}/invite/fleet/${token}` },
    });
    return { id, email, status: "pending", expiresAt: expiresAt.toISOString(), acceptedClientOrganizationId: null };
  });
}

export async function cancelAgencyInvitation(db: Db, actor: AgencyInvitationActor, invitationId: string): Promise<void> {
  const id = assertWorkspaceId(invitationId);
  await withTenant(db, actor.organizationId, async (tx) => {
    await assertInviter(tx, actor);
    const rows = await tx`update agency_client_invitations set status = 'canceled'
      where id = ${id} and agency_organization_id = ${actor.organizationId} and status in ('pending', 'expired') returning id`;
    if (!rows[0]) throw new HttpError(409, "AGENCY_INVITATION_UNAVAILABLE", "Cette invitation ne peut plus être annulée.");
  });
}
