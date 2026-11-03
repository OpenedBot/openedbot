import { activeOrganizationId } from "../session/cloud-session";
import type { BotUsageDto, DecisionDto, ModelUsageDto, OverviewDto, UsageDto } from "@openedbot/contracts-api";
import { API_ORIGIN, request } from "./http";

export const overviewApi = {
  overview: () => request<OverviewDto>("/api/overview"),
  /** Les quatre séries d'usage de jetons (jour/semaine/mois/année), zero-fill. */
  usage: () => request<UsageDto>("/api/usage"),
  /** Ventilation des runs achevés par modèle, 90 derniers jours. */
  usageModels: (days?: number) => request<ModelUsageDto>(days === undefined ? "/api/usage/models" : `/api/usage/models?days=${encodeURIComponent(String(days))}`),
  /** Consommation openedbot exacte par bot ; le fournisseur affiché est déduit côté client. */
  usageBots: (days = 7) => request<BotUsageDto>(`/api/usage/bots?days=${encodeURIComponent(String(days))}`),
  decisions: (filters: { botId?: string; choice?: "once" | "deny"; origin?: "human" | "policy" } = {}) => {
    const query = new URLSearchParams();
    if (filters.botId) query.set("botId", filters.botId);
    if (filters.choice) query.set("choice", filters.choice);
    if (filters.origin) query.set("origin", filters.origin);
    const suffix = query.size ? `?${query}` : "";
    return request<{ decisions: DecisionDto[] }>(`/api/decisions${suffix}`);
  },
  // Une URL et non un `fetch` : l'export est un téléchargement, et le navigateur
  // sait déjà le faire: le passer par `request` chargerait tout le journal en
  // mémoire pour le rendre aussitôt au disque.
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
