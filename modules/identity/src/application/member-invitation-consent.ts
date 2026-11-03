import type { OrganizationMemberInvitationPreview } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { hashCredential } from "@openedbot/platform-db/credential";
import { subscriptionPort } from "./subscription-port";
import { passwordProblem } from "../domain/password";
import { assertMemberCapacity } from "../domain/member-policy";

type Invitation = {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: "admin" | "member";
  expiresAt: Date;
};

function unavailable(): HttpError {
  return new HttpError(410, "MEMBER_INVITATION_UNAVAILABLE", "Invitation inconnue, expirée, annulée, remplacée ou déjà utilisée. Demandez une nouvelle invitation à un administrateur.");
}

async function withInvitation<T>(
  db: Db,
  token: string,
  action: (tx: TransactionDb, invitation: Invitation) => Promise<T>,
): Promise<T> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw unavailable();
  return db.begin(async (tx) => {
    const tokenHash = hashCredential(token);
    await tx`select set_config('app.member_invitation_hash', ${tokenHash}, true)`;
    const lookup = await tx<Array<{ organizationId: string }>>`select organization_id as "organizationId"
      from organization_member_invitations where token_hash = ${tokenHash}`;
    if (!lookup[0]) throw unavailable();
    await tx`select set_config('app.organization_id', ${lookup[0].organizationId}, true)`;
    // Une invitation émise avant la fermeture des invitations en espace
    // personnel ne s'accepte plus : elle se lit comme indisponible.
    const organizations = await tx<Array<{ name: string }>>`select name from organizations
      where id = ${lookup[0].organizationId} and deleted_at is null and kind <> 'personal' for no key update`;
    const rows = await tx<Invitation[]>`select id, organization_id as "organizationId", email, role,
      expires_at as "expiresAt" from organization_member_invitations
      where token_hash = ${tokenHash} and status = 'pending' for update`;
    const row = rows[0];
    if (!row || !organizations[0] || row.expiresAt.getTime() <= Date.now()) throw unavailable();
    return action(tx, { ...row, organizationName: organizations[0].name });
  }) as Promise<T>;
}

export async function previewMemberInvitation(db: Db, token: string): Promise<OrganizationMemberInvitationPreview> {
  return withInvitation(db, token, async (tx, invitation) => {
    const users = await tx`select id from users where lower(email) = ${invitation.email} limit 1`;
    return {
      status: "pending",
      organizationName: invitation.organizationName,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      hasAccount: Boolean(users[0]),
    };
  });
}

export async function registerMemberInvitee(db: Db, token: string, password: unknown): Promise<{ userId: string; email: string }> {
  if (typeof password !== "string" || passwordProblem(password)) {
    throw new HttpError(400, "PASSWORD_INVALID", "Choisissez au moins 12 caractères, une majuscule et un caractère spécial.");
  }
  const passwordHash = await Bun.password.hash(password);
  return withInvitation(db, token, async (tx, invitation) => {
    const id = crypto.randomUUID();
    const created = await tx`insert into users (id, email, password_hash, access_tier)
      values (${id}, ${invitation.email}, ${passwordHash}, 'classic') on conflict do nothing returning id`;
    if (!created[0]) {
      throw new HttpError(409, "MEMBER_INVITATION_LOGIN_REQUIRED", "Cette adresse possède déjà un compte. Connectez-vous pour continuer.");
    }
    return { userId: id, email: invitation.email };
  });
}

export async function respondToMemberInvitation(db: Db, input: {
  token: string;
  userId: string;
  accept: boolean;
}): Promise<{ status: "accepted" | "declined"; organizationId: string | null }> {
  return withInvitation(db, input.token, async (tx, invitation) => {
    const users = await tx<Array<{ email: string }>>`select email from users where id = ${input.userId} for update`;
    if (users[0]?.email.toLowerCase() !== invitation.email) {
      throw new HttpError(403, "MEMBER_INVITATION_EMAIL_MISMATCH", "Connectez-vous avec l'adresse de cette invitation.");
    }
    if (!input.accept) {
      await tx`update organization_member_invitations set status = 'declined', accepted_user_id = null
        where id = ${invitation.id}`;
      return { status: "declined", organizationId: null };
    }

    await tx`select id from organizations where id = ${invitation.organizationId} for no key update`;
    await tx`update organization_member_invitations set status = 'expired'
      where organization_id = ${invitation.organizationId} and status = 'pending'
        and expires_at <= now() and id <> ${invitation.id}`;
    const current = await tx<Array<{ role: "owner" | "admin" | "member"; revokedAt: Date | null }>>`
      select role, revoked_at as "revokedAt" from memberships
      where organization_id = ${invitation.organizationId} and user_id = ${input.userId} for update`;
    if (current[0]?.revokedAt === null) {
      throw new HttpError(409, "MEMBER_ALREADY", "Cette adresse appartient déjà à un membre de l’organisation.");
    }
    const memberLimit = await subscriptionPort().memberLimit(tx, invitation.organizationId);
    if (memberLimit !== null) {
      const liveRows = await tx<Array<{ count: string | number }>>`select count(*) as count from memberships
        where organization_id = ${invitation.organizationId} and revoked_at is null`;
      const pendingRows = await tx<Array<{ count: string | number }>>`select count(*) as count from organization_member_invitations
        where organization_id = ${invitation.organizationId} and status = 'pending' and id <> ${invitation.id}`;
      assertMemberCapacity(memberLimit,
        Number(liveRows[0]?.count ?? 0) + Number(pendingRows[0]?.count ?? 0));
    }
    if (current[0]) {
      await tx`update memberships set role = ${invitation.role}, revoked_at = null
        where organization_id = ${invitation.organizationId} and user_id = ${input.userId}`;
    } else {
      await tx`insert into memberships (organization_id, user_id, role)
        values (${invitation.organizationId}, ${input.userId}, ${invitation.role})`;
    }
    await tx`insert into membership_events (id, organization_id, actor_user_id, subject_user_id, kind, role)
      values (${crypto.randomUUID()}, ${invitation.organizationId}, ${input.userId}, ${input.userId}, 'member_joined', ${invitation.role})`;
    await tx`update organization_member_invitations set status = 'accepted', accepted_user_id = ${input.userId}
      where id = ${invitation.id}`;
    return { status: "accepted", organizationId: invitation.organizationId };
  });
}
