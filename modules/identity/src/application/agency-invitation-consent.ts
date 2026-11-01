import type { AgencyClientInvitationPreview } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { hashCredential } from "@openedbot/platform-db/credential";
import { enqueueTransactionalEmail } from "@openedbot/notifications/application/transactional-email";
import { runOrganizationCreating } from "./organization-creating";
import { passwordProblem } from "../domain/password";
import { defaultOrganizationName, organizationSlugCandidate } from "../domain/signup";
import { recordGrantEvents } from "./workspaces";
import { announceOrganizationCreated } from "./organization-created";

type Invitation = { id: string; agencyId: string; email: string; inviterId: string | null; expiresAt: Date; status: string };

async function withInvitation<T>(db: Db, token: string, action: (tx: TransactionDb, invitation: Invitation, agencyName: string) => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw unavailable();
  return db.begin(async (tx) => {
    const tokenHash = hashCredential(token);
    await tx`select set_config('app.agency_invitation_hash', ${tokenHash}, true)`;
    const lookup = await tx<Array<{ agencyId: string }>>`select agency_organization_id as "agencyId"
      from agency_client_invitations where token_hash = ${tokenHash}`;
    if (!lookup[0]) throw unavailable();
    // Match the inviter's lock order: agency first, then invitation. Re-read
    // the key under the row lock so a concurrent resend can only win once.
    await tx`select set_config('app.organization_id', ${lookup[0].agencyId}, true)`;
    const agencies = await tx<Array<{ name: string }>>`select name from organizations
      where id = ${lookup[0].agencyId} and kind = 'agency' and deleted_at is null for share`;
    if (!agencies[0]) throw unavailable();
    const rows = await tx<Invitation[]>`select id, agency_organization_id as "agencyId", email,
      invited_by_user_id as "inviterId", expires_at as "expiresAt", status
      from agency_client_invitations where token_hash = ${tokenHash} for update`;
    const invitation = rows[0];
    if (!invitation || invitation.status !== "pending" || invitation.expiresAt.getTime() <= Date.now()) throw unavailable();
    return action(tx, invitation, agencies[0].name);
  }) as Promise<T>;
}
function unavailable(): HttpError {
  return new HttpError(410, "AGENCY_INVITATION_UNAVAILABLE", "Invitation inconnue, expirée, annulée, remplacée ou déjà utilisée. Demandez une nouvelle invitation à l'agence.");
}

export async function previewAgencyInvitation(db: Db, token: string): Promise<AgencyClientInvitationPreview> {
  return withInvitation(db, token, async (tx, invitation, agencyName) => {
    const users = await tx`select id from users where lower(email) = ${invitation.email}`;
    return { status: "pending", agencyName, email: invitation.email, expiresAt: invitation.expiresAt.toISOString(), hasAccount: Boolean(users[0]) };
  });
}

/** Possession of the email-bound key verifies this email, without a waitlist gate. */
export async function registerAgencyInvitee(db: Db, token: string, password: unknown): Promise<{ userId: string; email: string }> {
  if (typeof password !== "string" || passwordProblem(password)) throw new HttpError(400, "PASSWORD_INVALID", "Choisissez au moins 12 caractères, une majuscule et un caractère spécial.");
  const passwordHash = await Bun.password.hash(password);
  return withInvitation(db, token, async (tx, invitation) => {
    const id = crypto.randomUUID();
    const created = await tx`insert into users (id, email, password_hash, access_tier)
      values (${id}, ${invitation.email}, ${passwordHash}, 'classic') on conflict do nothing returning id`;
    if (!created[0]) throw new HttpError(409, "AGENCY_INVITATION_LOGIN_REQUIRED", "Cette adresse possède déjà un compte. Connectez-vous pour continuer.");
    return { userId: id, email: invitation.email };
  });
}

export async function respondToAgencyInvitation(db: Db, input: {
  token: string; userId: string; accept: boolean; organizationName?: unknown;
  billingEnforced: boolean; environment: "development" | "test" | "production";
}): Promise<{ status: "accepted" | "declined"; organizationId: string | null; organizationCreated: boolean }> {
  type Response = { status: "accepted" | "declined"; organizationId: string | null; organizationCreated: boolean };
  const result: Response = await withInvitation<Response>(db, input.token, async (tx, invitation) => {
    // Serialize all invitations accepted by this account, including from different agencies.
    const users = await tx<Array<{ email: string }>>`select email from users where id = ${input.userId} for update`;
    if (users[0]?.email.toLowerCase() !== invitation.email) throw new HttpError(403, "AGENCY_INVITATION_EMAIL_MISMATCH", "Connectez-vous avec l'adresse de cette invitation.");
    let organizationId: string | null = null;
    let organizationCreated = false;
    const status: Response["status"] = input.accept ? "accepted" : "declined";
    if (input.accept) {
      await tx`select set_config('app.authenticating_user_id', ${input.userId}, true)`;
      const memberships = await tx<Array<{ id: string }>>`select organization_id as id from memberships
        where user_id = ${input.userId} and role = 'owner' and revoked_at is null order by created_at for share`;
      for (const membership of memberships) {
        await tx`select set_config('app.organization_id', ${membership.id}, true)`;
        const personal = await tx`select id from organizations where id = ${membership.id} and kind = 'personal' and deleted_at is null`;
        if (personal[0]) { organizationId = membership.id; break; }
      }
      if (!organizationId) {
        const name = typeof input.organizationName === "string" ? input.organizationName.trim() : defaultOrganizationName(invitation.email, null);
        if (!name || name.length > 80) throw new HttpError(400, "ORGANIZATION_NAME_REQUIRED", "Définissez le nom de votre organisation (80 caractères maximum).");
        organizationCreated = true;
        organizationId = crypto.randomUUID();
        await tx`select set_config('app.organization_id', ${organizationId}, true)`;
        const slug = organizationSlugCandidate(name, organizationId.replaceAll("-", "").slice(-12));
        await tx`insert into organizations (id, slug, name, kind, personal_owner_user_id)
          values (${organizationId}, ${slug}, ${name}, 'personal', ${input.userId})`;
        await tx`insert into memberships (organization_id, user_id, role) values (${organizationId}, ${input.userId}, 'owner')`;
        await runOrganizationCreating(tx, { organizationId, kind: "personal", billingEnforced: input.billingEnforced, environment: input.environment });
      }
      await tx`select set_config('app.organization_id', ${organizationId}, true)`;
      const grants = await tx`insert into agency_grants (id, agency_organization_id, client_organization_id, granted_by_user_id)
        values (${crypto.randomUUID()}, ${invitation.agencyId}, ${organizationId}, ${input.userId})
        on conflict do nothing returning id`;
      if (grants[0]) await recordGrantEvents(tx, { clientId: organizationId, agencyId: invitation.agencyId, actorUserId: input.userId, kind: "agency_granted" });
    }
    await tx`select set_config('app.organization_id', ${invitation.agencyId}, true)`;
    await tx`update agency_client_invitations set status = ${status}, accepted_client_organization_id = ${organizationId}
      where id = ${invitation.id}`;
    if (invitation.inviterId) {
      const inviters = await tx<Array<{ email: string }>>`select email from users where id = ${invitation.inviterId}`;
      if (inviters[0]) await enqueueTransactionalEmail(tx, {
        kind: "agency_client_response", recipientEmail: inviters[0].email, locale: "fr",
        dedupeKey: `agency-response:${invitation.id}`, payload: { email: invitation.email, status },
      });
    }
    return { status, organizationId, organizationCreated };
  });
  // After the commit: a new client organization is announced like any other.
  if (result.organizationCreated && result.organizationId) await announceOrganizationCreated(result.organizationId);
  return result;
}
