import type { WorkspaceRole } from "@openedbot/contracts-api";
import type { TransactionDb } from "@openedbot/platform-db";

export type MemberRow = {
  userId: string;
  email: string;
  displayName: string | null;
  role: WorkspaceRole;
  createdAt: Date | string;
};

export type OtherMembership = { id: string };
export type OrganizationFootprint = { kind: string; members: string | number };

export async function listActiveMembers(tx: TransactionDb, organizationId: string): Promise<MemberRow[]> {
  return tx<MemberRow[]>`
    select u.id as "userId", u.email, u.display_name as "displayName", m.role,
           m.created_at as "createdAt"
      from memberships m
      join users u on u.id = m.user_id
     where m.organization_id = ${organizationId} and m.revoked_at is null
     order by m.created_at asc
  `;
}

/** Sérialise les changements de membres d'une organisation (le rôle propriétaire ne se perd pas en concurrence). */
export async function lockOrganizationForMembership(tx: TransactionDb, organizationId: string): Promise<void> {
  await tx`select id from organizations where id = ${organizationId} for no key update`;
}

/** Le rôle de la membership vivante d'un compte dans une organisation, verrouillée quand la suite l'écrit. */
export async function readActiveMembershipRole(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  options: { lock?: boolean } = {},
): Promise<WorkspaceRole | null> {
  const rows = options.lock
    ? await tx<Array<{ role: WorkspaceRole }>>`
        select role from memberships
         where organization_id = ${organizationId} and user_id = ${userId} and revoked_at is null
         for update
      `
    : await tx<Array<{ role: WorkspaceRole }>>`
        select role from memberships
         where organization_id = ${organizationId} and user_id = ${userId} and revoked_at is null
      `;
  return rows[0]?.role ?? null;
}

export async function countActiveMembers(tx: TransactionDb, organizationId: string): Promise<number> {
  const rows = await tx<Array<{ count: string | number }>>`
    select count(*) as count from memberships where organization_id = ${organizationId} and revoked_at is null
  `;
  return Number(rows[0]?.count ?? 0);
}

/** Les AUTRES organisations où le compte a une membership vivante. */
export async function listOtherMemberships(
  tx: TransactionDb,
  userId: string,
  exceptOrganizationId: string,
): Promise<OtherMembership[]> {
  return tx<OtherMembership[]>`
    select organization_id as id from memberships
     where user_id = ${userId} and revoked_at is null
       and organization_id <> ${exceptOrganizationId}
  `;
}

/** Le genre et le nombre de membres vivants d'une organisation vivante, sous le tenant courant. */
export async function readOrganizationFootprint(
  tx: TransactionDb,
  organizationId: string,
): Promise<OrganizationFootprint | null> {
  const rows = await tx<OrganizationFootprint[]>`
    select o.kind, (select count(*) from memberships m
                     where m.organization_id = o.id and m.revoked_at is null) as members
      from organizations o where o.id = ${organizationId} and o.deleted_at is null
  `;
  return rows[0] ?? null;
}

export async function recordRoleChanged(
  tx: TransactionDb,
  event: { organizationId: string; actorUserId: string; subjectUserId: string; role: string },
): Promise<void> {
  await tx`insert into membership_events (id, organization_id, actor_user_id, subject_user_id, kind, role)
    values (${crypto.randomUUID()}, ${event.organizationId}, ${event.actorUserId}, ${event.subjectUserId}, 'role_changed', ${event.role})`;
}

export async function recordMemberRevoked(
  tx: TransactionDb,
  event: { organizationId: string; actorUserId: string; subjectUserId: string; role: string },
): Promise<void> {
  await tx`insert into membership_events (id, organization_id, actor_user_id, subject_user_id, kind, role)
    values (${crypto.randomUUID()}, ${event.organizationId}, ${event.actorUserId}, ${event.subjectUserId}, 'revoked', ${event.role})`;
}

export async function setMembershipRole(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  role: string,
): Promise<void> {
  await tx`
    update memberships set role = ${role}
     where organization_id = ${organizationId} and user_id = ${userId} and revoked_at is null
  `;
}

export async function revokeMembership(tx: TransactionDb, organizationId: string, userId: string): Promise<void> {
  await tx`update memberships set revoked_at = now()
    where organization_id = ${organizationId} and user_id = ${userId}`;
}
