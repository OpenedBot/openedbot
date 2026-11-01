import { activeFleetId, activeOrganizationId } from "../session/cloud-session";
import type { LegalSlug } from "@openedbot/contracts-api";

/** Personal and delegated views of the same client never share cached data or privileges. */
export function workspaceQueryKey<const Parts extends readonly unknown[]>(organizationId: string | null, ...parts: Parts) {
  const fleetId = activeFleetId();
  return fleetId
    ? ["organization", organizationId, "agency", fleetId, ...parts] as const
    : ["organization", organizationId, ...parts] as const;
}

export const queryKeys = {
  legalCatalog: ["legal", "catalog"] as const,
  legalDocument: (slug: LegalSlug) => ["legal", "document", slug] as const,
  get health() { return workspaceQueryKey(activeOrganizationId(), "health"); },
  get roster() { return workspaceQueryKey(activeOrganizationId(), "roster"); },
  get botProfileModelSync() { return workspaceQueryKey(activeOrganizationId(), "bot-profile-model-sync"); },
  /** Même clé que `roster` : sidebar, palette et carte du compte partagent le cache. */
  get rosterIncludingHidden() {
    return workspaceQueryKey(activeOrganizationId(), "roster");
  },
  get onboarding() { return workspaceQueryKey(activeOrganizationId(), "onboarding"); },
  get operator() { return workspaceQueryKey(activeOrganizationId(), "operator"); },
  get groups() { return workspaceQueryKey(activeOrganizationId(), "groups"); },
  /** Alias of `runtimeConfiguration`: `GET /api/runtime` has ONE cache entry (`runtimeQueryOptions`). */
  get runtime() { return workspaceQueryKey(activeOrganizationId(), "runtime-configuration"); },
  get connectorRelease() { return workspaceQueryKey(activeOrganizationId(), "connector-release"); },
  get runtimeConfiguration() { return workspaceQueryKey(activeOrganizationId(), "runtime-configuration"); },
  get runtimeIntegrations() { return workspaceQueryKey(activeOrganizationId(), "runtime-integrations"); },
  get runtimeProfiles() { return workspaceQueryKey(activeOrganizationId(), "runtime-profiles"); },
  get runtimeProfileDeleteJobs() { return workspaceQueryKey(activeOrganizationId(), "runtime-profile-delete-jobs"); },
  get runtimeMcp() { return workspaceQueryKey(activeOrganizationId(), "runtime-mcp"); },
  get runtimeGateway() { return workspaceQueryKey(activeOrganizationId(), "runtime-gateway"); },
  get alertChannels() { return workspaceQueryKey(activeOrganizationId(), "alert-channels"); },
  runtimeMcpOauth: (name: string, sessionId: string) =>
    workspaceQueryKey(activeOrganizationId(), "runtime-mcp-oauth", name, sessionId),
  runtimeGatewayRestart: (jobId: string) =>
    workspaceQueryKey(activeOrganizationId(), "runtime-gateway-restart", jobId),
  /** Alias of `runtimeConfiguration`, read through `runtimesQueryOptions`. */
  get runtimes() { return workspaceQueryKey(activeOrganizationId(), "runtime-configuration"); },
  /** Publications en cours : relues après chaque publication, déclaration ou révocation. */
  get runtimeExposures() { return workspaceQueryKey(activeOrganizationId(), "runtime-exposures"); },
  /** Tableau brut de `api.runtimeList` : clé distincte de `runtimes` (`{ runtimes }`), sinon les deux formes se chevauchent dans le cache. */
  get hermesImportJobs() { return workspaceQueryKey(activeOrganizationId(), "hermes-import-jobs"); },
  get runtimeList() { return workspaceQueryKey(activeOrganizationId(), "runtime-list"); },
  /** Sondé tant qu'un ticket d'appairage est affiché ; une clé par enrôlement. */
  runtimeEnrollmentStatus: (enrollmentId: string) =>
    workspaceQueryKey(activeOrganizationId(), "runtime-enrollment-status", enrollmentId),
  get overview() { return workspaceQueryKey(activeOrganizationId(), "overview"); },
  get usage() { return workspaceQueryKey(activeOrganizationId(), "usage"); },
  get usageModels() { return workspaceQueryKey(activeOrganizationId(), "usage-models"); },
  usageBots: (days: number) => workspaceQueryKey(activeOrganizationId(), "usage-bots", days),
  routines: (botId: string) => workspaceQueryKey(activeOrganizationId(), "routines", botId),
  groupRoutines: (groupId: string) => workspaceQueryKey(activeOrganizationId(), "group-routines", groupId),
  botRoutineTool: (botId: string) => workspaceQueryKey(activeOrganizationId(), "routine-tool", botId),
  botSettingsTool: (botId: string) => workspaceQueryKey(activeOrganizationId(), "settings-tool", botId),
  routineExecutions: (routineId: string) =>
    workspaceQueryKey(activeOrganizationId(), "routine-executions", routineId),
  get routineReceiptsRoot() {
    return workspaceQueryKey(activeOrganizationId(), "routine-receipts");
  },
  routineReceipts: (routineId: string, status: string) =>
    workspaceQueryKey(activeOrganizationId(), "routine-receipts", routineId, status),
  workflowHistory: (status: string) =>
    workspaceQueryKey(activeOrganizationId(), "workflow-history", status),
  get inbox() { return workspaceQueryKey(activeOrganizationId(), "inbox"); },
  get authProviders() { return ["auth", "providers"] as const; },
  /** Bootstrap stays account scoped; a delegated view reads its own effective privileges. */
  get authMe() {
    const fleetId = activeFleetId();
    return fleetId ? ["auth", "me", activeOrganizationId(), "agency", fleetId] as const : ["auth", "me"] as const;
  },
  get accountSecurity() { return workspaceQueryKey(activeOrganizationId(), "account-security"); },
  organizationMembers: (orgId: string) => workspaceQueryKey(orgId, "organization-members"),
  organizationInvitations: (orgId: string) => workspaceQueryKey(orgId, "organization-invitations"),
  authClaim: (attemptId: string) => workspaceQueryKey(activeOrganizationId(), "auth-claim", attemptId),
  thread: (threadId: string) => workspaceQueryKey(activeOrganizationId(), "thread", threadId),
  messageVersions: (threadId: string) =>
    workspaceQueryKey(activeOrganizationId(), "message-versions", threadId),
  decisions: (filters: { botId?: string; choice?: string; origin?: string } = {}) =>
    workspaceQueryKey(activeOrganizationId(), "decisions", filters.botId ?? "", filters.choice ?? "", filters.origin ?? ""),
  botCapabilities: (botId: string) =>
    workspaceQueryKey(activeOrganizationId(), "bot-capabilities", botId),
  botToolPolicies: (botId: string) =>
    workspaceQueryKey(activeOrganizationId(), "bot-tool-policies", botId),
  botProfileStatus: (botId: string) =>
    workspaceQueryKey(activeOrganizationId(), "bot-profile-status", botId),
  botToolErrors: (botId: string) =>
    workspaceQueryKey(activeOrganizationId(), "bot-tool-errors", botId),
  botPermissionGrants: (botId: string) =>
    workspaceQueryKey(activeOrganizationId(), "bot-permission-grants", botId),
  runtimePermissionSettings: (runtimeId: string) =>
    workspaceQueryKey(activeOrganizationId(), "runtime-permission-settings", runtimeId),
  botRuntimeMemory: (botId: string) =>
    workspaceQueryKey(activeOrganizationId(), "bot-runtime-memory", botId),
  personaDraft: (botId: string) =>
    workspaceQueryKey(activeOrganizationId(), "persona-draft", botId),
  botComputer: (botId: string) =>
    workspaceQueryKey(activeOrganizationId(), "bot-computer", botId),
  webhooks: (threadId: string) =>
    workspaceQueryKey(activeOrganizationId(), "webhooks", threadId),
  runtimeModels: (runtimeId: string) =>
    workspaceQueryKey(activeOrganizationId(), "runtime-models", runtimeId),
  runtimeProviderUsage: (runtimeId: string) =>
    workspaceQueryKey(activeOrganizationId(), "runtime-provider-usage", runtimeId),
  runtimeModelContext: (runtimeId: string, profile: string | null) =>
    workspaceQueryKey(activeOrganizationId(), "runtime-model-context", runtimeId, profile ?? ""),
  providerOauth: (runtimeId: string, providerSlug: string, sessionId: string) =>
    workspaceQueryKey(activeOrganizationId(), "provider-oauth", runtimeId, providerSlug, sessionId),
  runtimeSshBootstrap: (runtimeId: string) =>
    workspaceQueryKey(activeOrganizationId(), "runtime-ssh-bootstrap", runtimeId),
  /**
   * L'historique du guichet. SANS organisation dans la clé, contrairement à
   * tout ce qui précède : un fil de support suit un COMPTE, pas un tenant, et
   * changer d'organisation ne change pas les conversations qu'on a eues avec
   * le support.
   */
  supportHistory: ["support", "history"] as const,
  /** The workspace directory of an account; the route guards fill it before the sidebar reads it. */
  accountWorkspaces: (userId: string) => ["account-workspaces", userId] as const,
};
