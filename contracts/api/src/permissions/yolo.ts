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
/** Le YOLO par défaut du mode solo local : l'owner d'une organisation à un seul membre, pas plus. */
export const YOLO_SOLO_NOT_ELIGIBLE_CODE = "YOLO_SOLO_NOT_ELIGIBLE";

export const YOLO_ERROR_CODES = [
  YOLO_HUMAN_REQUIRED_CODE,
  YOLO_BLOCKED_BY_POLICY_CODE,
  YOLO_HOST_UNSUPPORTED_CODE,
  YOLO_ACK_REQUIRED_CODE,
  YOLO_SIGNING_UNAVAILABLE_CODE,
  YOLO_SOLO_NOT_ELIGIBLE_CODE,
] as const;

export type YoloErrorCode = (typeof YOLO_ERROR_CODES)[number];

/**
 * Le statut HTTP de chaque refus : une identité qui n'est pas un humain (403),
 * une politique d'organisation ou un hôte qui ne le permet pas (409), une
 * première confirmation manquante (428), une clé de signature absente (503 :
 * jamais de bail non signé), une organisation qui n'est pas solo (409).
 */
export const YOLO_ERROR_STATUS: Readonly<Record<YoloErrorCode, 403 | 409 | 428 | 503>> = {
  YOLO_HUMAN_REQUIRED: 403,
  YOLO_BLOCKED_BY_POLICY: 409,
  YOLO_HOST_UNSUPPORTED: 409,
  YOLO_ACK_REQUIRED: 428,
  YOLO_SIGNING_UNAVAILABLE: 503,
  YOLO_SOLO_NOT_ELIGIBLE: 409,
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
  /**
   * Mode solo local : bail runtime renouvelé par le système pour le compte de
   * l'owner. Toujours envoyé par l'API ; absent se lit `false`.
   */
  soloDefault?: boolean;
};

/** Ce que l'état effectif d'un bot dit d'un bail actif sur lui (`EffectivePermission.yolo`). */
export type EffectiveYolo = { leaseId: string; scope: YoloScope; expiresAt: string };

/** Le corps de `POST /api/organization/yolo/leases`. `runtimeId` absent : le runtime actif. */
export type YoloGrantRequest = {
  scope: YoloScope;
  runtimeId?: string;
  botId?: string;
  threadId?: string;
  /** 1 à 1440 ; absent : 4 h (`YOLO_THREAD_DEFAULT_SECONDS`). */
  durationMinutes?: number;
  /** La confirmation de la première fois ; exigée tant qu'aucune n'est enregistrée (428). */
  acknowledged?: boolean;
};

/**
 * Une clé publique de signature des baux, que l'hôte épingle : `keyId` (16
 * premiers octets hex de sha256(clé)) et la clé brute de 32 octets en base64.
 * `current` : celle qui signe les nouveaux baux ; les autres vérifient
 * encore les baux qu'elles ont signés.
 */
export type YoloLeaseKeyDto = { keyId: string; publicKey: string; current: boolean };

/**
 * `soloDefault` : le YOLO par défaut du mode solo local (bail runtime de 24 h
 * renouvelé tant que l'organisation n'a qu'un membre). `soloEligible` : la
 * personne peut l'activer (owner d'une organisation à un seul membre).
 */
export type YoloConsentDto = { acknowledgedAt: string | null; soloDefault: boolean; soloEligible: boolean };

/** Une auto-approbation remontée par l'hôte : le hash des arguments seulement. */
export type YoloAuditEntryDto = {
  id: string;
  runtimeId: string;
  leaseId: string;
  writeSeq: number;
  occurredAt: string;
  profile: string;
  gateKind: string;
  toolKey: string | null;
  argsHash: string;
  entryHash: string;
};

export type YoloAuditPageDto = { entries: YoloAuditEntryDto[]; nextCursor: string | null };

/** « Couper YOLO partout » : les baux révoqués à l'instant, et les runtimes prévenus. */
export type YoloKillResultDto = { revoked: number; runtimes: number };
