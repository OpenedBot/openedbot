import { activeOrganizationId } from "../session/cloud-session";
import type { LegalSlug } from "@openedbot/contracts-api";

/** Two organizations never share cached data. */
export function workspaceQueryKey<const Parts extends readonly unknown[]>(organizationId: string | null, ...parts: Parts) {
  return ["organization", organizationId, ...parts] as const;
}

export const queryKeys = {
  get workspacePreferences() { return workspaceQueryKey(activeOrganizationId(), "workspace-preferences"); },
  conversationFiles: (threadId: string, search: string) => workspaceQueryKey(activeOrganizationId(), "files", threadId, search),
  accountDeletion: ["account", "deletion"] as const,
  legalCatalog: ["legal", "catalog"] as const,
  legalDocument: (slug: LegalSlug) => ["legal", "document", slug] as const,
  get health() { return workspaceQueryKey(activeOrganizationId(), "health"); },
  get roster() { return workspaceQueryKey(activeOrganizationId(), "roster"); },
  get botProfileModelSync() { return workspaceQueryKey(activeOrganizationId(), "bot-profile-model-sync"); },
  /** Same key as `roster`: sidebar, palette and account card share the cache. */
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
  /** In-flight publications: reread after each publication, declaration or revocation. */
  get runtimeExposures() { return workspaceQueryKey(activeOrganizationId(), "runtime-exposures"); },
  /** Raw array of `api.runtimeList`: a key distinct from `runtimes` (`{ runtimes }`), otherwise the two shapes overlap in the cache. */
  get hermesImportJobs() { return workspaceQueryKey(activeOrganizationId(), "hermes-import-jobs"); },
  get runtimeList() { return workspaceQueryKey(activeOrganizationId(), "runtime-list"); },
  /** Polled while a pairing ticket is shown; one key per enrollment. */
  runtimeEnrollmentStatus: (enrollmentId: string) =>
    workspaceQueryKey(activeOrganizationId(), "runtime-enrollment-status", enrollmentId),
  get overview() { return workspaceQueryKey(activeOrganizationId(), "overview"); },
  get usage() { return workspaceQueryKey(activeOrganizationId(), "usage"); },
  get usageModels() { return workspaceQueryKey(activeOrganizationId(), "usage-models"); },
  usageModelsWindow: (days: number) => workspaceQueryKey(activeOrganizationId(), "usage-models", days),
  usageBots: (days: number) => workspaceQueryKey(activeOrganizationId(), "usage-bots", days),
  routines: (botId: string) => workspaceQueryKey(activeOrganizationId(), "routines", botId),
  groupRoutines: (groupId: string) => workspaceQueryKey(activeOrganizationId(), "group-routines", groupId),
  botRoutineTool: (botId: string) => workspaceQueryKey(activeOrganizationId(), "routine-tool", botId),
  botSettingsTool: (botId: string) => workspaceQueryKey(activeOrganizationId(), "settings-tool", botId),
  routineExecutions: (routineId: string) =>
    workspaceQueryKey(activeOrganizationId(), "routine-executions", routineId),
  workflowHistory: (status: string) =>
    workspaceQueryKey(activeOrganizationId(), "workflow-history", status),
  get inbox() { return workspaceQueryKey(activeOrganizationId(), "inbox"); },
  globalSearch: (query: string) => workspaceQueryKey(activeOrganizationId(), "global-search", query),
  get authProviders() { return ["auth", "providers"] as const; },
  /** Bootstrap stays account scoped. */
  authMe: ["auth", "me"] as const,
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
  /** The workspace directory of an account; the route guards fill it before the sidebar reads it. */
  accountWorkspaces: (userId: string) => ["account-workspaces", userId] as const,
};
