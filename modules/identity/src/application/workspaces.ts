import type { AccountWorkspace, FleetGrantDto, MembershipRole, OrganizationKind } from "@openedbot/contracts-api";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withAuthenticatingUser, withTenant } from "@openedbot/platform-db";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { assertWorkspaceId } from "../domain/workspace-access";

/** Tenant reads fan out, but never more than four transactions at once. */
const READ_BATCH = 4;

async function inBatches<T, R>(items: readonly T[], read: (item: T) => Promise<R | null>): Promise<R[]> {
  const result: R[] = [];
  for (let offset = 0; offset < items.length; offset += READ_BATCH) {
    const batch = await Promise.all(items.slice(offset, offset + READ_BATCH).map(read));
    result.push(...batch.filter((row): row is Awaited<R> => row !== null));
  }
  return result;
}

type OrganizationRow = { id: string; name: string; slug: string; kind: OrganizationKind };

async function readLivingOrganization(db: Db, organizationId: string): Promise<OrganizationRow | null> {
  return withTenant(db, organizationId, async (tx) => {
    const rows = await tx<OrganizationRow[]>`select id, name, slug, kind from organizations
      where id = ${organizationId} and deleted_at is null`;
    return rows[0] ?? null;
  });
}

/**
 * Billing gates of a workspace. An agency organization stays outside the
 * paywall until the staff turns `agency_billing` on from the backoffice.
 */
export type BillingGate = { billingEnforced: boolean; fleetBillingEnabled: boolean };

export function subscriptionRequired(kind: OrganizationKind, gate: BillingGate): boolean {
  return gate.billingEnforced && (kind !== "agency" || gate.fleetBillingEnabled);
}

/**
 * Every workspace an account can open: its own organizations first (direct
 * memberships), then the clients its agencies were let into. Membership
 * discovery and tenant reads remain separate RLS doors.
 */
export async function listAccountWorkspaces(db: Db, userId: string, agencyAvailable: boolean): Promise<AccountWorkspace[]> {
  const memberships = await withAuthenticatingUser(db, userId, (tx) => tx<Array<{ id: string; role: MembershipRole }>>`
    select organization_id as id, role from memberships where user_id = ${userId} and revoked_at is null
       order by created_at, organization_id`);
  const own = await inBatches(memberships, async (membership): Promise<AccountWorkspace | null> => {
    const organization = await readLivingOrganization(db, membership.id);
    if (!organization || (!agencyAvailable && organization.kind === "agency")) return null;
    return { ...organization, role: membership.role };
  });
  if (!agencyAvailable) return own;

  const viaByClient = new Map<string, string[]>();
  const agencies = own.filter((workspace) => workspace.kind === "agency");
  const grants = await inBatches(agencies, (agency) => withTenant(db, agency.id, (tx) =>
    tx<Array<{ agencyId: string; clientId: string }>>`select agency_organization_id as "agencyId",
      client_organization_id as "clientId" from agency_grants
      where agency_organization_id = ${agency.id} and revoked_at is null order by created_at, id`));
  for (const grant of grants.flat()) {
    viaByClient.set(grant.clientId, [...(viaByClient.get(grant.clientId) ?? []), grant.agencyId]);
  }
  const ownIds = new Set(own.map((workspace) => workspace.id));
  const clients = await inBatches([...viaByClient].filter(([id]) => !ownIds.has(id)),
    async ([id, viaAgencyIds]): Promise<AccountWorkspace | null> => {
      const organization = await readLivingOrganization(db, id);
      if (!organization || organization.kind !== "personal") return null;
      return { ...organization, role: "agency", viaAgencyIds };
    });
  const ownWithMandates = own.map((workspace) => {
    const viaAgencyIds = viaByClient.get(workspace.id);
    return viaAgencyIds?.length ? { ...workspace, viaAgencyIds } : workspace;
  });
  return [...ownWithMandates, ...clients];
}

/** Both sides keep their own access journal; each row is written under its own tenant. */
export async function recordGrantEvents(tx: TransactionDb, input: {
  clientId: string; agencyId: string; actorUserId: string; kind: "agency_granted" | "agency_revoked";
}): Promise<void> {
  for (const [organizationId, subjectOrganizationId] of [[input.clientId, input.agencyId], [input.agencyId, input.clientId]] as const) {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    await tx`insert into membership_events (id, organization_id, actor_user_id, subject_organization_id, kind, role)
      values (${crypto.randomUUID()}, ${organizationId}, ${input.actorUserId}, ${subjectOrganizationId}, ${input.kind}, 'agency')`;
  }
}

/** The agencies a client organization currently lets in. */
export async function listClientFleetGrants(db: Db, clientOrganizationId: string): Promise<FleetGrantDto[]> {
  const grants = await withTenant(db, clientOrganizationId, (tx) => tx<Array<{
    id: string; agencyOrganizationId: string; createdAt: Date | string;
  }>>`select id, agency_organization_id as "agencyOrganizationId", created_at as "createdAt" from agency_grants
    where client_organization_id = ${clientOrganizationId} and revoked_at is null order by created_at, id`);
  return inBatches(grants, async (grant): Promise<FleetGrantDto | null> => {
    const agency = await readLivingOrganization(db, grant.agencyOrganizationId);
    if (!agency) return null;
    const createdAt = grant.createdAt instanceof Date ? grant.createdAt.toISOString() : new Date(grant.createdAt).toISOString();
    return { id: grant.id, agencyOrganizationId: agency.id, agencyName: agency.name, createdAt };
  });
}

/**
 * Closes one grant, from either side: the client owner withdraws an agency, or
 * the agency leaves a client. Members of the agency lose that client at their
 * next request, because access is derived and nothing else is written.
 */
export async function revokeFleetGrant(db: Db, input: {
  actorUserId: string;
  actingOrganizationId: string;
  side: "client" | "agency";
  /** Client side: the grant id. Agency side: the client organization id. */
  target: string;
}): Promise<void> {
  const target = assertWorkspaceId(input.target);
  await withTenant(db, input.actingOrganizationId, async (tx) => {
    await tx`select id from organizations where id = ${input.actingOrganizationId} for no key update`;
    const revoked = input.side === "client"
      ? await tx<Array<{ clientId: string; agencyId: string }>>`update agency_grants
          set revoked_at = now(), revoked_by_user_id = ${input.actorUserId}
          where id = ${target} and client_organization_id = ${input.actingOrganizationId} and revoked_at is null
          returning client_organization_id as "clientId", agency_organization_id as "agencyId"`
      : await tx<Array<{ clientId: string; agencyId: string }>>`update agency_grants
          set revoked_at = now(), revoked_by_user_id = ${input.actorUserId}
          where client_organization_id = ${target} and agency_organization_id = ${input.actingOrganizationId}
            and revoked_at is null
          returning client_organization_id as "clientId", agency_organization_id as "agencyId"`;
    const grant = revoked[0];
    if (!grant) throw new HttpError(404, "AGENCY_GRANT_NOT_FOUND", "Cet accès agence est introuvable.");
    await recordGrantEvents(tx, { ...grant, actorUserId: input.actorUserId, kind: "agency_revoked" });
  });
}
