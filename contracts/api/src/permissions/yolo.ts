/**
 * Mode YOLO : un bail signé et daté qui laisse l'HÔTE auto-approuver les
 * demandes d'un thread, d'un bot ou d'un runtime, hors liste hardline,
 * deny-list d'organisation et protections. Owner ou admin seulement ; un bot
 * ne s'en octroie jamais. La charge utile signée est le contrat de fil
 * (`@openedbot/contracts-connector`, `relay-frames-yolo.ts`) ; ce module
 * porte ce que l'API et les clients en voient.
 */

import type { YoloHostLeaseStatus, YoloLeaseV1, YoloScope } from "@openedbot/contracts-connector/yolo";

export { YOLO_SCOPES } from "@openedbot/contracts-connector/yolo";
export type { YoloScope } from "@openedbot/contracts-connector/yolo";

/** La charge utile canonique v1 (entiers, secondes epoch). */
export type YoloLease = YoloLeaseV1;

/** Durée par défaut d'un bail `thread` : 4 h. */
export const YOLO_THREAD_DEFAULT_SECONDS = 14_400;
/** Durée maximale de tout bail : 24 h. */
export const YOLO_MAX_SECONDS = 86_400;

export const YOLO_HUMAN_REQUIRED_CODE = "YOLO_HUMAN_REQUIRED";
export const YOLO_BLOCKED_BY_POLICY_CODE = "YOLO_BLOCKED_BY_POLICY";
export const YOLO_HOST_UNSUPPORTED_CODE = "YOLO_HOST_UNSUPPORTED";
export const YOLO_ACK_REQUIRED_CODE = "YOLO_ACK_REQUIRED";
export const YOLO_SIGNING_UNAVAILABLE_CODE = "YOLO_SIGNING_UNAVAILABLE";

export const YOLO_ERROR_CODES = [
  YOLO_HUMAN_REQUIRED_CODE,
  YOLO_BLOCKED_BY_POLICY_CODE,
  YOLO_HOST_UNSUPPORTED_CODE,
  YOLO_ACK_REQUIRED_CODE,
  YOLO_SIGNING_UNAVAILABLE_CODE,
] as const;

export type YoloErrorCode = (typeof YOLO_ERROR_CODES)[number];

/**
 * Le statut HTTP de chaque refus : une identité qui n'est pas un humain (403),
 * une politique d'organisation ou un hôte qui ne le permet pas (409), une
 * première confirmation manquante (428), une clé de signature absente (503 :
 * jamais de bail non signé).
 */
export const YOLO_ERROR_STATUS: Readonly<Record<YoloErrorCode, 403 | 409 | 428 | 503>> = {
  YOLO_HUMAN_REQUIRED: 403,
  YOLO_BLOCKED_BY_POLICY: 409,
  YOLO_HOST_UNSUPPORTED: 409,
  YOLO_ACK_REQUIRED: 428,
  YOLO_SIGNING_UNAVAILABLE: 503,
};

/** L'état que le cloud tient d'un bail : `pending` tant que l'hôte n'a rien dit. */
export type YoloLeaseHostState = "pending" | YoloHostLeaseStatus;

export type YoloLeaseDto = {
  id: string;
  scope: YoloScope;
  runtimeId: string;
  /** `bot` et `thread`. */
  botId: string | null;
  /** `thread` seulement. */
  threadId: string | null;
  grantedByUserId: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  hostState: YoloLeaseHostState;
  deliveredAt: string | null;
};

/** Ce que l'état effectif d'un bot dit d'un bail actif sur lui (`EffectivePermission.yolo`). */
export type EffectiveYolo = { leaseId: string; scope: YoloScope; expiresAt: string };
