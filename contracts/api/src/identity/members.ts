/** The three roles of a membership: `AuthContext["role"]` on the API side. */
type OrganizationRole = "owner" | "admin" | "member";

/** The role a role change or an invitation may target: never `owner`. */
export type AssignableRole = Exclude<OrganizationRole, "owner">;

export const ASSIGNABLE_ROLES: readonly AssignableRole[] = ["admin", "member"];

/** `createdAt`: the membership date, always served by `GET /api/organization/members`. */
export type OrganizationMemberDto = {
  userId: string;
  email: string;
  displayName: string | null;
  role: OrganizationRole;
  createdAt: string;
};

export type MemberRoleChangedDto = { userId: string; role: AssignableRole };

/** A member invitation to the inviter's workspace: a single `pending` per address. */
export type OrganizationMemberInvitationStatus = "pending" | "accepted" | "declined" | "canceled" | "expired";

export type OrganizationMemberInvitationDto = {
  id: string;
  email: string;
  role: AssignableRole;
  status: OrganizationMemberInvitationStatus;
  expiresAt: string;
};

/**
 * Response of `GET /api/organization/invitations`: the actionable invitations
 * (`pending`, `expired`), newest first. `truncated`: more exist than were returned.
 */
export type OrganizationMemberInvitationListDto = {
  invitations: OrganizationMemberInvitationDto[];
  truncated: boolean;
};

/** The public preview of `GET /api/invite/member/:token`, served only while the invitation is `pending`. */
export type OrganizationMemberInvitationPreview = {
  status: "pending";
  organizationName: string;
  email: string;
  role: AssignableRole;
  expiresAt: string;
  hasAccount: boolean;
};

/** Response of `POST /api/invite/member/:token/accept|decline`. */
export type OrganizationMemberInvitationResponseDto = {
  status: "accepted" | "declined";
  organizationId: string | null;
};

/** Response of `GET /api/organization/members`, with the pending invitations for owner/admin. */
export type OrganizationMemberListDto = {
  members: OrganizationMemberDto[];
  pendingInvitations?: OrganizationMemberInvitationDto[];
  /** More actionable invitations exist than `pendingInvitations` holds. */
  pendingInvitationsTruncated?: boolean;
};
