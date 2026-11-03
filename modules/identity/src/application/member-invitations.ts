import type { InvitableRole, OrganizationMemberInvitationDto } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { hashCredential, randomCredential } from "@openedbot/platform-db/credential";
import { subscriptionPort } from "./subscription-port";
import { enqueueTransactionalEmail } from "@openedbot/notifications/application/transactional-email";
import { isEmailSyntaxValid, normalizeEmail } from "../domain/email-address";
import { assertMemberCapacity } from "../domain/member-policy";
import { assertWorkspaceId } from "../domain/workspace-access";
import { assertEmailDeliverable, defaultEmailDomainChecker } from "./email-deliverability";
import type { EmailDomainResolver } from "./email-domain-check";

export type MemberInvitationActor = { organizationId: string; userId: string };

type InvitationRow = {
  id: string;
  email: string;
  role: InvitableRole;
  status: OrganizationMemberInvitationDto["status"];
  expiresAt: Date;
};

function dto(row: InvitationRow): OrganizationMemberInvitationDto {
  return { ...row, expiresAt: row.expiresAt.toISOString() };
}

function invitationRole(value: unknown): InvitableRole {
  if (value !== "admin" && value !== "member") {
    throw new HttpError(400, "ROLE_INVALID", "Le rôle doit être admin ou member.");
  }
  return value;
}

async function assertInviter(tx: TransactionDb, actor: MemberInvitationActor): Promise<{ name: string; kind: string }> {
  const organizations = await tx<Array<{ name: string; kind: string }>>`select name, kind from organizations
    where id = ${actor.organizationId} and deleted_at is null for no key update`;
  const memberships = await tx`select role from memberships where organization_id = ${actor.organizationId}
    and user_id = ${actor.userId} and revoked_at is null and role in ('owner', 'admin')`;
  if (!organizations[0] || !memberships[0]) {
    throw new HttpError(403, "MEMBER_INVITATION_FORBIDDEN", "Seuls les propriétaires et administrateurs peuvent inviter un membre.");
  }
  return organizations[0];
}

async function expirePending(tx: TransactionDb, organizationId: string): Promise<void> {
  await tx`update organization_member_invitations set status = 'expired'
    where organization_id = ${organizationId} and status = 'pending' and expires_at <= now()`;
}

export async function assertCapacity(tx: TransactionDb, organizationId: string): Promise<void> {
  const memberLimit = await subscriptionPort().memberLimit(tx, organizationId);
  if (memberLimit === null) return;
  const liveRows = await tx<Array<{ count: string | number }>>`select count(*) as count from memberships
    where organization_id = ${organizationId} and revoked_at is null`;
  const pendingRows = await tx<Array<{ count: string | number }>>`select count(*) as count from organization_member_invitations
    where organization_id = ${organizationId} and status = 'pending'`;
  const occupied = Number(liveRows[0]?.count ?? 0) + Number(pendingRows[0]?.count ?? 0);
  assertMemberCapacity(memberLimit, occupied);
}

async function liveMember(tx: TransactionDb, organizationId: string, email: string): Promise<boolean> {
  const rows = await tx`select 1 from memberships m join users u on u.id = m.user_id
    where m.organization_id = ${organizationId} and m.revoked_at is null and lower(u.email) = ${email} limit 1`;
  return Boolean(rows[0]);
}

export async function listMemberInvitations(
  db: Db,
  actor: MemberInvitationActor,
): Promise<OrganizationMemberInvitationDto[]> {
  return withTenant(db, actor.organizationId, async (tx) => {
    await assertInviter(tx, actor);
    await expirePending(tx, actor.organizationId);
    const rows = await tx<InvitationRow[]>`select id, email, role, status, expires_at as "expiresAt"
      from organization_member_invitations where organization_id = ${actor.organizationId}
      order by created_at desc, id limit 200`;
    return rows.map(dto);
  });
}

export async function sendMemberInvitation(db: Db, actor: MemberInvitationActor, input: {
  email?: unknown;
  role?: unknown;
  invitationId?: string;
  locale?: unknown;
  webUrl: string;
}, checkDomain: EmailDomainResolver = defaultEmailDomainChecker()): Promise<OrganizationMemberInvitationDto> {
  const token = randomCredential(32);
  // A new address is proven deliverable before the transaction opens: the DNS
  // lookup can take up to three seconds and must not hold the organization lock.
  let requested: { email: string; role: InvitableRole } | null = null;
  if (!input.invitationId) {
    if (typeof input.email !== "string" || !isEmailSyntaxValid(input.email)) {
      throw new HttpError(400, "EMAIL_INVALID", "Adresse email invalide.");
    }
    requested = { email: normalizeEmail(input.email), role: invitationRole(input.role) };
    await assertEmailDeliverable(requested.email, checkDomain, "member_invitation");
  }
  return withTenant(db, actor.organizationId, async (tx) => {
    const organization = await assertInviter(tx, actor);
    // Seule une agence agrandit son équipe : un espace personnel n'accueille
    // pas d'autre membre, ni par une nouvelle invitation ni par un renvoi.
    if (organization.kind === "personal") {
      throw new HttpError(409, "MEMBER_INVITATION_PERSONAL", "Un espace personnel n’accueille pas d’autre membre.");
    }
    const organizationName = organization.name;
    await expirePending(tx, actor.organizationId);

    let id: string = crypto.randomUUID();
    let email: string;
    let role: InvitableRole;
    let wasPending = false;
    if (input.invitationId) {
      id = assertWorkspaceId(input.invitationId);
      const existing = await tx<Array<{ email: string; role: InvitableRole; status: OrganizationMemberInvitationDto["status"]; expiresAt: Date }>>`
        select email, role, status, expires_at as "expiresAt" from organization_member_invitations
        where id = ${id} and organization_id = ${actor.organizationId}
          and status in ('pending', 'expired') for update`;
      if (!existing[0]) {
        throw new HttpError(409, "MEMBER_INVITATION_UNAVAILABLE", "Cette invitation ne peut plus être renvoyée.");
      }
      email = existing[0].email;
      role = existing[0].role;
      wasPending = existing[0].status === "pending";
      // The domain may have gone away since the first send.
      await assertEmailDeliverable(email, checkDomain, "member_invitation");
    } else {
      email = requested!.email;
      role = requested!.role;
    }

    if (await liveMember(tx, actor.organizationId, email)) {
      throw new HttpError(409, "MEMBER_ALREADY", "Cette adresse appartient déjà à un membre de l’organisation.");
    }
    const duplicate = await tx`select id from organization_member_invitations
      where organization_id = ${actor.organizationId} and email = ${email} and status = 'pending' and id <> ${id}`;
    if (duplicate[0]) {
      throw new HttpError(409, "MEMBER_INVITATION_PENDING", "Une invitation est déjà en attente pour cette adresse.");
    }
    if (!wasPending) await assertCapacity(tx, actor.organizationId);

    const tokenHash = hashCredential(token);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    if (input.invitationId) {
      await tx`update organization_member_invitations set token_hash = ${tokenHash}, expires_at = ${expiresAt},
        status = 'pending', invited_by_user_id = ${actor.userId}, accepted_user_id = null
        where id = ${id} and organization_id = ${actor.organizationId}`;
    } else {
      await tx`insert into organization_member_invitations
        (id, organization_id, email, role, token_hash, invited_by_user_id, expires_at)
        values (${id}, ${actor.organizationId}, ${email}, ${role}, ${tokenHash}, ${actor.userId}, ${expiresAt})`;
    }
    await tx`insert into membership_events (id, organization_id, actor_user_id, kind, role)
      values (${crypto.randomUUID()}, ${actor.organizationId}, ${actor.userId}, 'member_invited', ${role})`;
    const origin = new URL(input.webUrl).origin;
    await enqueueTransactionalEmail(tx, {
      kind: "organization_member_invitation",
      dedupeKey: `organization-member-invitation:${id}:${tokenHash}`,
      recipientEmail: email,
      locale: input.locale === "en" ? "en" : "fr",
      payload: { organizationName, role, invitationUrl: `${origin}/invite/member/${token}` },
    });
    return { id, email, role, status: "pending", expiresAt: expiresAt.toISOString() };
  });
}

export async function cancelMemberInvitation(
  db: Db,
  actor: MemberInvitationActor,
  invitationId: string,
): Promise<void> {
  const id = assertWorkspaceId(invitationId);
  await withTenant(db, actor.organizationId, async (tx) => {
    await assertInviter(tx, actor);
    const canceled = await tx<Array<{ role: InvitableRole }>>`update organization_member_invitations
      set status = 'canceled' where id = ${id} and organization_id = ${actor.organizationId}
      and status in ('pending', 'expired') returning role`;
    const invitation = canceled[0];
    if (!invitation) {
      throw new HttpError(409, "MEMBER_INVITATION_UNAVAILABLE", "Cette invitation ne peut plus être annulée.");
    }
    await tx`insert into membership_events (id, organization_id, actor_user_id, kind, role)
      values (${crypto.randomUUID()}, ${actor.organizationId}, ${actor.userId}, 'member_invitation_canceled', ${invitation.role})`;
  });
}
