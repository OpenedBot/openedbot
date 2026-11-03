export type AgencyAuditEventDto = {
  id: string;
  kind: "agency_granted" | "agency_revoked";
  role: string;
  actorUserId: string;
  occurredAt: string;
};

export type AgencyAuditPageDto = {
  events: AgencyAuditEventDto[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
};

export type AgencyJournalEventKind =
  | "invited"
  | "accepted"
  | "role_changed"
  | "revoked"
  | "member_invited"
  | "member_joined"
  | "member_invitation_canceled"
  | "agency_granted"
  | "agency_revoked";

export type AgencyJournalEventDto = {
  id: string;
  kind: AgencyJournalEventKind;
  role: string | null;
  actor: { userId: string; label: string } | null;
  subjectUser: { userId: string; label: string } | null;
  subjectOrganization: { organizationId: string; name: string } | null;
  occurredAt: string;
};

export type AgencyJournalPageDto = {
  events: AgencyJournalEventDto[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
};
