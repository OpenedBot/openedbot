import type { LegalCatalogDto, LegalDocumentDto, LegalSlug } from "@openedbot/contracts-api";
import type { GlobalSearchPageDto } from "@openedbot/roster/domain/global-search";
import { request } from "./http";

export const workspaceApi = {
  // `environment` is absent from an API older than the field.
  health: () => request<{ ok: boolean; version: string; environment?: "dev" | "preprod" | "prod"; supportDesk?: boolean }>("/api/health"),
  globalSearch: (query: string, limit = 12) => {
    const parameters = new URLSearchParams({ q: query, limit: String(limit) });
    return request<GlobalSearchPageDto>(`/api/search?${parameters.toString()}`);
  },
  legalCatalog: () => request<LegalCatalogDto>("/api/legal"),
  legalDocument: (slug: LegalSlug) => request<LegalDocumentDto>(`/api/legal/${encodeURIComponent(slug)}`),
};
