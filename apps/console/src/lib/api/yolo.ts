import type {
  YoloAuditPageDto,
  YoloConsentDto,
  YoloGrantRequest,
  YoloKillResultDto,
  YoloLeaseDto,
} from "@openedbot/contracts-api";
import { request } from "./http";

export type YoloLeaseFilters = { runtimeId?: string; botId?: string; threadId?: string };

function query(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

/**
 * Mode YOLO : `/api/organization/yolo`. Tout membre lit les baux vivants ;
 * owner et admin octroient, révoquent, coupent tout et lisent l'audit. Un
 * refus revient nommé (`YOLO_*` et `details.reason`), jamais rabattu en
 * silence : `components/yolo/yolo-shared.ts` le dit à l'écran.
 */
export const yoloApi = {
  yoloLeases: (filters: YoloLeaseFilters = {}) =>
    request<{ leases: YoloLeaseDto[] }>(`/api/organization/yolo/leases${query(filters)}`),
  grantYoloLease: (input: YoloGrantRequest) =>
    request<{ lease: YoloLeaseDto }>("/api/organization/yolo/leases", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeYoloLease: (leaseId: string) =>
    request<{ lease: YoloLeaseDto }>(`/api/organization/yolo/leases/${encodeURIComponent(leaseId)}`, { method: "DELETE" }),
  /** « Couper YOLO partout » : tous les baux de l'organisation. */
  killYolo: () =>
    request<YoloKillResultDto>("/api/organization/yolo/kill", { method: "POST", body: JSON.stringify({}) }),
  yoloAudit: (cursor: string | null = null, leaseId: string | null = null) =>
    request<YoloAuditPageDto>(`/api/organization/yolo/audit${query({ cursor, leaseId })}`),
  yoloConsent: () => request<YoloConsentDto>("/api/organization/yolo/consent"),
  /** La confirmation de la première fois, par la personne elle-même. */
  saveYoloConsent: () =>
    request<YoloConsentDto>("/api/organization/yolo/consent", {
      method: "PUT",
      body: JSON.stringify({ acknowledged: true }),
    }),
};
