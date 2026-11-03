import type { AgencyBusinessSummary, MetricsPeriod, WorkspaceBusinessMetrics } from "../agency/business-metrics";

/**
 * The access role on a workspace. `agency` is never stored on a membership: it
 * is derived from a live `agency_grants` row (migration 0086).
 */
export type WorkspaceRole = "owner" | "admin" | "member" | "agency";

/** A role an actual `memberships` row can carry. */
export type MembershipRole = Exclude<WorkspaceRole, "agency">;

export type OrganizationKind = "personal" | "agency";

export function canOperateWorkspace(role: string): boolean {
  return role === "owner" || role === "admin" || role === "agency";
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
  /** Agencies with a live mandate to this client, independent of its direct membership role. */
  viaAgencyIds?: string[];
};

export type AccountWorkspacesDto = {
  userId: string;
  agencyAvailable: boolean;
  workspaces: AccountWorkspace[];
};

export type CreateOrganizationInput = { kind: OrganizationKind; name: string };

export type CreatedOrganizationDto = { organizationId: string; slug: string; kind: OrganizationKind };

/** An agency that a client organization has let in. */
export type FleetGrantDto = {
  id: string;
  agencyOrganizationId: string;
  agencyName: string;
  createdAt: string;
};

export type FleetRuntime = {
  id: string;
  name: string;
  reachability: string;
  health: string;
  lastSeenAt: string | null;
  lastProbedAt: string | null;
  error: string | null;
};

export type FleetClient = {
  workspace: AccountWorkspace;
  runtime: FleetRuntime | null;
  /** Time of the openedbot data read, independent of the runtime's heartbeat/probe. */
  observedAt?: string;
  /** Active and archived agents combined, kept for older clients. */
  agentCount: number;
  error: boolean;
  providerIncidents?: Array<{ provider: string; kind: string }>;
  metrics?: WorkspaceBusinessMetrics | null;
  period?: MetricsPeriod;
  errorCode?: "CLIENT_READ_FAILED";
};

export type AgencyFleetDto = {
  clients: FleetClient[];
  authorizedTotal?: number;
  filteredTotal?: number;
  period?: MetricsPeriod;
  summary?: AgencyBusinessSummary;
  page: number;
  hasMore: boolean;
  observedAt: string;
};

export type AgencyClientDto = FleetClient & {
  /** The exact mandate verified for this response, never an inferred direct membership. */
  mandate?: {
    agencyOrganizationId: string;
    clientOrganizationId: string;
    state: "active";
    verifiedAt: string;
  };
  accessEvents: Array<{ id: string; kind: string; role: string; actorUserId: string; occurredAt: string }>;
  verifications: Array<{ id: string; verdict: string; occurredAt: string }>;
  events: Array<{ id: string; kind: string; occurredAt: string }>;
  diagnostics: Array<{ id: string; code: string; component: string; occurredAt: string }>;
};
