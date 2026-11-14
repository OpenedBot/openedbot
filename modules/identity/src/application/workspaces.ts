import type { AccountWorkspace, WorkspaceRole } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";
import { withAuthenticatingUser, withTenant } from "@openedbot/platform-db";

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

type OrganizationRow = { id: string; name: string; slug: string };

async function readLivingOrganization(db: Db, organizationId: string): Promise<OrganizationRow | null> {
  return withTenant(db, organizationId, async (tx) => {
    const rows = await tx<OrganizationRow[]>`select id, name, slug from organizations
      where id = ${organizationId} and deleted_at is null`;
    return rows[0] ?? null;
  });
}

/**
 * Every workspace an account can open: its live direct memberships, in
 * joining order. Membership discovery and tenant reads remain separate RLS
 * doors. `kind` is the constant `personal` installed consoles still read.
 */
export async function listAccountWorkspaces(db: Db, userId: string): Promise<AccountWorkspace[]> {
  const memberships = await withAuthenticatingUser(db, userId, (tx) => tx<Array<{ id: string; role: WorkspaceRole }>>`
    select organization_id as id, role from memberships
     where user_id = ${userId} and revoked_at is null
     order by created_at, organization_id`);
  return inBatches(memberships, async (membership): Promise<AccountWorkspace | null> => {
    const organization = await readLivingOrganization(db, membership.id);
    if (!organization) return null;
    return { ...organization, role: membership.role, kind: "personal" };
  });
}
