import type {
  AssignableRole,
  OrganizationMemberInvitationDto,
  OrganizationMemberInvitationListDto,
  OrganizationMemberInvitationPreview,
  OrganizationMemberInvitationResponseDto,
} from "@openedbot/contracts-api";
import { request } from "./http";

/**
 * Member invitations: the workspace side (owner/admin, under the active
 * workspace) and the invitee side (`/api/invite/member/:token`, by its token,
 * without the organization header: the invitee is not a member yet).
 */
export const memberInvitationApi = {
  organizationInvitations: () => request<OrganizationMemberInvitationListDto>("/api/organization/invitations"),
  inviteOrganizationMember: (email: string, role: AssignableRole, locale: string) =>
    request<OrganizationMemberInvitationDto>("/api/organization/invitations", {
      method: "POST", body: JSON.stringify({ email, role, locale }),
    }),
  resendOrganizationInvitation: (id: string, locale: string) =>
    request<OrganizationMemberInvitationDto>(`/api/organization/invitations/${encodeURIComponent(id)}/resend`, {
      method: "POST", body: JSON.stringify({ locale }),
    }),
  cancelOrganizationInvitation: (id: string) =>
    request<void>(`/api/organization/invitations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  previewMemberInvitation: (token: string) =>
    request<OrganizationMemberInvitationPreview>(`/api/invite/member/${encodeURIComponent(token)}`, undefined, { skipOrganizationHeader: true }),
  respondToMemberInvitation: (token: string, accept: boolean) =>
    request<OrganizationMemberInvitationResponseDto>(`/api/invite/member/${encodeURIComponent(token)}/${accept ? "accept" : "decline"}`, {
      method: "POST", body: "{}",
    }, { skipOrganizationHeader: true }),
};
