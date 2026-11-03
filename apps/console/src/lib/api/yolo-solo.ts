import type { YoloConsentDto } from "@openedbot/contracts-api";
import { request } from "./http";

/**
 * Mode YOLO, solo local : le YOLO par défaut d'une organisation à un seul
 * membre, porté par le consentement (`/api/organization/yolo/consent`).
 * L'activer est réservé à l'owner seul de son espace (409
 * `YOLO_SOLO_NOT_ELIGIBLE` sinon) ; le couper révoque aussi les baux solo.
 */
export const yoloSoloApi = {
  yoloSoloConsent: () => request<YoloConsentDto>("/api/organization/yolo/consent"),
  setYoloSoloDefault: (soloDefault: boolean) =>
    request<YoloConsentDto>("/api/organization/yolo/consent", {
      method: "PUT",
      body: JSON.stringify({ acknowledged: true, soloDefault }),
    }),
};
