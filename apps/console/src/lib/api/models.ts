import type { ModelAssignmentMode, ModelAssignmentModeInput, RuntimeModelCatalogDto, RuntimeModelContextDto, RuntimeModelSelectionInput, RuntimeProviderCredentialDto, RuntimeProviderOauthDto, RuntimeProviderUsageDto, RuntimePublicDto } from "@openedbot/contracts-api";
import { request } from "./http";

export const modelsApi = {
  runtimeModels: (runtimeId: string) =>
    request<RuntimeModelCatalogDto>(`/api/runtimes/${runtimeId}/models`),
  runtimeProviderUsage: (runtimeId: string, refresh = false) =>
    request<RuntimeProviderUsageDto>(`/api/runtimes/${runtimeId}/provider-usage${refresh ? "?refresh=1" : ""}`),
  runtimeModelContext: (runtimeId: string, profile?: string | null) =>
    request<RuntimeModelContextDto>(
      `/api/runtimes/${runtimeId}/model-context${profile ? `?profile=${encodeURIComponent(profile)}` : ""}`,
    ),
  saveRuntimeModelSelection: (runtimeId: string, input: RuntimeModelSelectionInput) =>
    request<RuntimePublicDto>(`/api/runtimes/${runtimeId}/model-selection`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  /** Cancels a pending verification, or dismisses a failed verification. */
  cancelRuntimeModelSelection: (runtimeId: string) =>
    request<RuntimePublicDto>(`/api/runtimes/${runtimeId}/model-selection/pending`, { method: "DELETE" }),
  /**
   * Saves the model assignment mode. It lives on the organization, not
   * on a runtime: the route therefore names none.
   */
  saveModelAssignmentMode: (mode: ModelAssignmentMode) =>
    request<{ modelAssignmentMode: ModelAssignmentMode }>("/api/runtimes/assignment-mode", {
      method: "PUT",
      body: JSON.stringify({ mode } satisfies ModelAssignmentModeInput),
    }).then((result) => result.modelAssignmentMode),
  setProviderApiKey: (runtimeId: string, providerSlug: string, apiKey: string) =>
    request<RuntimeProviderCredentialDto>(
      `/api/runtimes/${runtimeId}/providers/${encodeURIComponent(providerSlug)}/credentials`,
      { method: "POST", body: JSON.stringify({ apiKey }) },
    ),
  startProviderOauth: (runtimeId: string, providerSlug: string) =>
    request<RuntimeProviderOauthDto>(
      `/api/runtimes/${runtimeId}/providers/${encodeURIComponent(providerSlug)}/auth`,
      { method: "POST", body: "{}" },
    ),
  providerOauth: (runtimeId: string, providerSlug: string, sessionId: string) =>
    request<RuntimeProviderOauthDto>(
      `/api/runtimes/${runtimeId}/providers/${encodeURIComponent(providerSlug)}/auth?sessionId=${encodeURIComponent(sessionId)}`,
    ),
  cancelProviderOauth: (runtimeId: string, providerSlug: string, sessionId: string) =>
    request<void>(
      `/api/runtimes/${runtimeId}/providers/${encodeURIComponent(providerSlug)}/auth?sessionId=${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    ),
};
