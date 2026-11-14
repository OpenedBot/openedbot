import type { WorkspaceRole } from "@openedbot/contracts-api";
import type { TransactionDb } from "@openedbot/platform-db";

export type WorkspaceAccess = {
  /** `null`: the organization is alive but this account has no access to it. */
  role: WorkspaceRole | null;
};

const MEMBERSHIP_ROLES: readonly string[] = ["owner", "admin", "member"] satisfies readonly WorkspaceRole[];

/**
 * The single definition of workspace access (`workspace_access`): a live
 * direct membership. Only its `role` is read; a role that is not a membership
 * role (a delegated access the database may still derive) opens nothing.
 * `null` when the organization does not exist or is deleted.
 */
export async function readWorkspaceAccess(
  tx: TransactionDb,
  userId: string,
  organizationId: string,
): Promise<WorkspaceAccess | null> {
  const rows = await tx<Array<{ role: string | null }>>`
    select role from workspace_access(${userId}::uuid, ${organizationId}::uuid)
  `;
  const row = rows[0];
  if (!row) return null;
  return { role: row.role !== null && MEMBERSHIP_ROLES.includes(row.role) ? row.role as WorkspaceRole : null };
}
