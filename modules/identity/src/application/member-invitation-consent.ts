import type { OrganizationMemberInvitationPreview, OrganizationMemberInvitationResponseDto } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { hashCredential } from "@openedbot/platform-db/credential";
import { livingWorkspacesExcept, lockAccountWorkspace, memberAlreadyInWorkspace } from "../sql/accounts";
import { markUserOnboardingCompleted } from "../sql/onboarding";
import { assertCapacity } from "./member-invitations";

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

/**
 * The token is the only key: `app.member_invitation_hash` opens the single
 * invitation row it hashes to (RLS, 0120), then the tenant is set to its
 * workspace. Any state but a live `pending` invitation of a living,
 * personal workspace reads as unavailable.
 */
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
    const organizations = await tx<Array<{ name: string }>>`select name from organizations
      where id = ${lookup[0].organizationId} and deleted_at is null and kind = 'personal' for no key update`;
    // Sous ce même verrou d'organisation, la programmation d'une suppression
    // (`account-deletion.ts`) compte les membres : une organisation dont la
    // purge est programmée n'accueille plus personne.
    const deletions = await tx`select 1 from tenant_deletions where organization_id = ${lookup[0].organizationId}`;
    if (deletions[0]) throw unavailable();
    const rows = await tx<Array<Omit<Invitation, "organizationName">>>`select id, organization_id as "organizationId", email, role,
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

/**
 * The signed-in invitee answers. An invitee without an account signs up
 * first through the ordinary e-mail code sign-in, which creates the account
 * and NO workspace (`verifyEmailLoginCode`, `organizationId: null`).
 *
 * Accepting gives a membership with the invited role in the inviter's
 * workspace, and nothing else: one account, one workspace. An account that
 * already owns or belongs to another living workspace on this instance is
 * refused (409 `MEMBER_ALREADY_IN_WORKSPACE`) and the invitation stays
 * pending. The welcome flow is for whoever sets a workspace up: a person
 * joining an existing one leaves it as done.
 */
export async function respondToMemberInvitation(db: Db, input: {
  token: string;
  userId: string;
  accept: boolean;
}): Promise<OrganizationMemberInvitationResponseDto> {
  return withInvitation(db, input.token, async (tx, invitation) => {
    // Lock order, the same as `createOrganization`: the account lock FIRST,
    // then the user row. Taking the row first deadlocked against a concurrent
    // creation, which holds the account lock and needs the row's key-share
    // lock for its membership foreign key. `for no key update` does not block
    // that key-share lock anyway: the row is read, its key never changes.
    await lockAccountWorkspace(tx, input.userId);
    const users = await tx<Array<{ email: string }>>`select email from users where id = ${input.userId} for no key update`;
    if (users[0]?.email.toLowerCase() !== invitation.email) {
      throw new HttpError(403, "MEMBER_INVITATION_EMAIL_MISMATCH", "Connectez-vous avec l'adresse de cette invitation.");
    }
    if (!input.accept) {
      await tx`update organization_member_invitations set status = 'declined', accepted_user_id = null
        where id = ${invitation.id}`;
      return { status: "declined", organizationId: null };
    }

    const current = await tx<Array<{ role: "owner" | "admin" | "member"; revokedAt: Date | null }>>`
      select role, revoked_at as "revokedAt" from memberships
      where organization_id = ${invitation.organizationId} and user_id = ${input.userId} for update`;
    if (current[0]?.revokedAt === null) {
      throw new HttpError(409, "MEMBER_ALREADY", "Cette adresse appartient déjà à un membre de l’espace.");
    }
    if ((await livingWorkspacesExcept(tx, input.userId, invitation.organizationId)).length > 0) {
      throw memberAlreadyInWorkspace();
    }
    await tx`update organization_member_invitations set status = 'expired'
      where organization_id = ${invitation.organizationId} and status = 'pending'
        and expires_at <= now() and id <> ${invitation.id}`;
    await assertCapacity(tx, invitation.organizationId, invitation.id);
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
    await markUserOnboardingCompleted(tx, input.userId);
    return { status: "accepted", organizationId: invitation.organizationId };
  });
}
