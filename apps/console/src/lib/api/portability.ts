import type { HermesBundleImportInput, HermesBundleImportJobDto, HermesBundleImportJobListDto, RuntimeProfileDeleteDto, RuntimeProfileDeleteJobDto, RuntimeProfileDeleteJobListDto, RuntimeProfileImportDto, RuntimeProfileInventoryDto } from "@openedbot/contracts-api";
import { ApiError, request } from "./http";

export const portabilityApi = {
  runtimeProfiles: async () => {
    try {
      return await request<RuntimeProfileInventoryDto>("/api/runtime/profiles");
    } catch (error) {
      if (
        error instanceof ApiError
        && error.status === 404
        && (error.code === "PROFILE_INVENTORY_UNAVAILABLE" || error.code === "RUNTIME_REQUIRED")
      ) {
        return null;
      }
      throw error;
    }
  },
  deleteRuntimeProfile: (slug: string) =>
    request<RuntimeProfileDeleteDto>(`/api/runtime/profiles/${encodeURIComponent(slug)}`, { method: "DELETE" }),
  enqueueRuntimeProfileDelete: (slugs: string[]) =>
    request<RuntimeProfileDeleteJobDto>("/api/runtime/profiles/delete-jobs", {
      method: "POST",
      body: JSON.stringify({ slugs }),
    }),
  runtimeProfileDeleteJobs: () => request<RuntimeProfileDeleteJobListDto>("/api/runtime/profiles/delete-jobs"),
  importHermesBundle: (input: HermesBundleImportInput) => request<HermesBundleImportJobDto>("/api/team-imports/hermes-bundle", { method: "POST", body: JSON.stringify(input) }),
  hermesImportJobs: (cursor?: string) => request<HermesBundleImportJobListDto>(`/api/team-imports/hermes-bundle/jobs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  hermesImportJob: (id: string) => request<HermesBundleImportJobDto>(`/api/team-imports/hermes-bundle/jobs/${encodeURIComponent(id)}`),
  acknowledgeHermesImport: (id: string) => request<HermesBundleImportJobDto>(`/api/team-imports/hermes-bundle/jobs/${encodeURIComponent(id)}/acknowledge`, { method: "POST", body: JSON.stringify({ verifiedOnHost: true }) }),
  importRuntimeProfiles: (input: { profiles: string[]; sectionId?: string }) =>
    request<RuntimeProfileImportDto>("/api/team-imports/runtime", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
