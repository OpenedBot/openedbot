export type AgencyClientInvitationStatus = "pending" | "accepted" | "declined" | "canceled" | "expired";

export type AgencyClientInvitationDto = {
  id: string;
  email: string;
  status: AgencyClientInvitationStatus;
  expiresAt: string;
  acceptedClientOrganizationId: string | null;
};

export type AgencyClientInvitationPreview = {
  status: "pending";
  agencyName: string;
  email: string;
  expiresAt: string;
  hasAccount: boolean;
};
