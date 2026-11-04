import { memberInvitationApi } from "@openedbot/browser-api-client";
import type { PermissionContextDto, RuntimeConfigurationDto, RuntimePublicDto } from "@openedbot/contracts-api";
import { request } from "./api/http";
import { queryKeys } from "./api/query-keys";
import { workspaceApi } from "./api/workspace";
import { supportApi } from "./api/support";
import { rosterApi } from "./api/roster";
import { portabilityApi } from "./api/portability";
import { webhooksApi } from "./api/webhooks";
import { onboardingApi } from "./api/onboarding";
import { groupsApi } from "./api/groups";
import { routinesApi } from "./api/routines";
import { threadsApi } from "./api/threads";
import { approvalsApi } from "./api/approvals";
import { runtimeIntegrationsApi } from "./api/runtime-integrations";
import { runtimeApi } from "./api/runtime";
import { botsApi } from "./api/bots";
import { modelsApi } from "./api/models";
import { overviewApi } from "./api/overview";
import { authApi } from "./api/auth";
import { accountApi } from "./api/account";
import { notificationsApi } from "./api/notifications";
import { mergeApiParts } from "./api/merge";
import { bindApi } from "./api/self";

export { API_ORIGIN, ApiError, assertFleetClientRequestContext, errorMessage, fleetAuditRequestContext, fleetClientRequestContext, isAlphaClosed, isApiUnavailable, isUnauthorized, isWorkspaceChanged, request, userFacingError } from "./api/http";
export { queryKeys, workspaceQueryKey } from "./api/query-keys";
export type { CreateBotInput, MobileConnectTicketDto, OnboardingResetScope, SendMessageResult, ThreadView, WorkflowRecoveryResult } from "./api/types";

/**
 * The console's HTTP client, one object assembled from its domain parts
 * (`lib/api/<domain>.ts`). Property descriptors are kept, so a getter still
 * reads the assembled object, and a duplicated key fails at load.
 */
export const api = mergeApiParts(
  memberInvitationApi(
    <T>(path: string, init?: RequestInit) => request<T>(path, init),
    <T>(path: string, init?: RequestInit) => request<T>(path, init, { skipOrganizationHeader: true }),
  ),
  workspaceApi,
  supportApi,
  rosterApi,
  portabilityApi,
  webhooksApi,
  onboardingApi,
  groupsApi,
  routinesApi,
  threadsApi,
  approvalsApi,
  runtimeIntegrationsApi,
  runtimeApi,
  botsApi,
  modelsApi,
  overviewApi,
  authApi,
  accountApi,
  notificationsApi,
);
bindApi(api);

export type Api = typeof api;

const selectRuntime = (configuration: RuntimeConfigurationDto): RuntimePublicDto | null => configuration.runtime ?? null;

const selectRuntimes = (configuration: RuntimeConfigurationDto): { runtimes: RuntimePublicDto[] } =>
  ({ runtimes: configuration.runtime ? [configuration.runtime] : [] });

/**
 * The active runtime, read out of the one `GET /api/runtime` cache entry.
 * Three keys used to cache that same URL, and a page load fetched it once per
 * key; the screens now share the read and differ only by their `select`.
 */
export function runtimeQueryOptions() {
  return { queryKey: queryKeys.runtimeConfiguration, queryFn: api.runtimeConfiguration, select: selectRuntime };
}

/** PERM2-3: pipeline, ceiling and review proof, out of the same `GET /api/runtime` entry. */
export function permissionContextQueryOptions() {
  return {
    queryKey: queryKeys.runtimeConfiguration,
    queryFn: api.runtimeConfiguration,
    select: (configuration: RuntimeConfigurationDto): PermissionContextDto | null => configuration.permissionContext ?? null,
  };
}

/** The same entry, shaped as the registry list some screens iterate on. */
export function runtimesQueryOptions() {
  return { queryKey: queryKeys.runtimeConfiguration, queryFn: api.runtimeConfiguration, select: selectRuntimes };
}
