import type { OrganizationKind, WorkspaceRole } from "@openedbot/contracts-api";
import type { TransactionDb } from "@openedbot/platform-db";

export type WorkspaceAccess = {
  /** `null`: the organization is alive but this account has no access to it. */
  role: WorkspaceRole | null;
  kind: OrganizationKind;
  viaAgencyIds: string[];
};

/**
 * The single definition of workspace access (`workspace_access`, migration
 * 0086): a live direct membership, otherwise a live grant from an agency the
 * account belongs to. `null` when the organization does not exist or is deleted.
 */
export async function readWorkspaceAccess(
  tx: TransactionDb,
  userId: string,
  organizationId: string,
): Promise<WorkspaceAccess | null> {
  const rows = await tx<Array<{ role: WorkspaceRole | null; kind: OrganizationKind; viaAgencyIds: string[] | null }>>`
    select role, kind, via_agency_ids as "viaAgencyIds" from workspace_access(${userId}::uuid, ${organizationId}::uuid)
  `;
  const row = rows[0];
  if (!row) return null;
  return { role: row.role, kind: row.kind, viaAgencyIds: row.viaAgencyIds ?? [] };
}

/** Agency organizations and agency-derived access close together when the product feature is off. */
export function agencyAccessAllowed(access: WorkspaceAccess, agencyEnabled: boolean): boolean {
  return agencyEnabled || (access.role !== "agency" && access.kind !== "agency");
}
