/** The access role on a workspace: the role of a live direct membership. */
export type WorkspaceRole = "owner" | "admin" | "member";

/**
 * Every organization is personal. Still sent on the wire: installed consoles
 * find the personal workspace through `kind === "personal"`.
 */
export type OrganizationKind = "personal";

export function canOperateWorkspace(role: string): boolean {
  return role === "owner" || role === "admin";
}

export function canManageWorkspaceMembers(role: string): boolean {
  return role === "owner" || role === "admin";
}

export type AccountWorkspace = {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  kind: OrganizationKind;
};

export type AccountWorkspacesDto = {
  userId: string;
  /** Always `false`: still sent for installed consoles that read it. */
  agencyAvailable: false;
  workspaces: AccountWorkspace[];
};

/** `kind` is optional and ignored: installed consoles still send `"personal"`. */
export type CreateOrganizationInput = { kind?: OrganizationKind; name: string };

export type CreatedOrganizationDto = { organizationId: string; slug: string; kind: OrganizationKind };
