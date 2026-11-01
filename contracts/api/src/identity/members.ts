/** Les trois rôles d'une adhésion : `AuthContext["role"]` côté API. */
type OrganizationRole = "owner" | "admin" | "member" | "agency";

/** Le rôle qu'une invitation ou un changement de rôle peut viser : jamais `owner`. */
export type InvitableRole = Exclude<OrganizationRole, "owner" | "agency">;

export const INVITABLE_ROLES: readonly InvitableRole[] = ["admin", "member"];

/** `createdAt` : la date d'adhésion, servie depuis toujours par `GET /api/organization/members`. */
export type OrganizationMemberDto = {
  userId: string;
  email: string;
  displayName: string | null;
  role: OrganizationRole;
  createdAt: string;
};

export type MemberRoleChangedDto = { userId: string; role: InvitableRole };

/** Une invitation de membre dans une organisation (DEV-OHB-234) : un seul `pending` par adresse. */
export type OrganizationMemberInvitationStatus = "pending" | "accepted" | "declined" | "canceled" | "expired";

export type OrganizationMemberInvitationDto = {
  id: string;
  email: string;
  role: InvitableRole;
  status: OrganizationMemberInvitationStatus;
  expiresAt: string;
};

/** L'aperçu public de `GET /api/invite/member/:token`, servi seulement tant que l'invitation est `pending`. */
export type OrganizationMemberInvitationPreview = {
  status: "pending";
  organizationName: string;
  email: string;
  role: InvitableRole;
  expiresAt: string;
  hasAccount: boolean;
};

/** Réponse de `GET /api/organization/members`, avec les invitations pour owner/admin. */
export type OrganizationMemberListDto = {
  members: OrganizationMemberDto[];
  pendingInvitations?: OrganizationMemberInvitationDto[];
};
