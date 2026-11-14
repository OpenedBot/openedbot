import { activeOrganizationId } from "../session/cloud-session";
import type { BotUsageDto, DecisionDto, ModelUsageDto, OverviewDto, UsageDto } from "@openedbot/contracts-api";
import { API_ORIGIN, request } from "./http";

export const overviewApi = {
  overview: () => request<OverviewDto>("/api/overview"),
  /** The four token-usage series (day/week/month/year), zero-fill. */
  usage: () => request<UsageDto>("/api/usage"),
  /** Breakdown of finished runs by model, last 90 days. */
  usageModels: (days?: number) => request<ModelUsageDto>(days === undefined ? "/api/usage/models" : `/api/usage/models?days=${encodeURIComponent(String(days))}`),
  /** Exact openedbot consumption per bot; the displayed provider is inferred on the client. */
  usageBots: (days = 7) => request<BotUsageDto>(`/api/usage/bots?days=${encodeURIComponent(String(days))}`),
  decisions: (filters: { botId?: string; choice?: "once" | "deny"; origin?: "human" | "policy" } = {}) => {
    const query = new URLSearchParams();
    if (filters.botId) query.set("botId", filters.botId);
    if (filters.choice) query.set("choice", filters.choice);
    if (filters.origin) query.set("origin", filters.origin);
    const suffix = query.size ? `?${query}` : "";
    return request<{ decisions: DecisionDto[] }>(`/api/decisions${suffix}`);
  },
  // A URL and not a `fetch`: the export is a download, and the browser
  // already knows how: passing it through `request` would load the whole log
  // into memory only to write it straight back to disk.
  decisionsExportUrl: (filters: { botId?: string; choice?: "once" | "deny"; origin?: "human" | "policy" } = {}) => {
    const query = new URLSearchParams();
    const organizationId = activeOrganizationId();
    if (organizationId) query.set("organizationId", organizationId);
    if (filters.botId) query.set("botId", filters.botId);
    if (filters.choice) query.set("choice", filters.choice);
    if (filters.origin) query.set("origin", filters.origin);
    const suffix = query.size ? `?${query}` : "";
    return `${API_ORIGIN}/api/decisions/export${suffix}`;
  },
};
