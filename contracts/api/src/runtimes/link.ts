import type { RuntimeConnectorDto } from "./connector";

export type RuntimeLinkDto = {
  /** Identité du connecteur déclaré ; null avant la première déclaration d'agent. */
  connector?: RuntimeConnectorDto | null;
  /** Un WebSocket de lien est ouvert en ce moment. */
  connected: boolean;
  /** Bail de la connexion courante (entier décimal) ; change à chaque reconnexion. `null` sans lien. */
  generation?: string | null;
  /** Ouverture de la connexion courante, ISO ; `null` sans lien. */
  connectedAt?: string | null;
  /** Dernier signe de vie du lien, ISO ; `null` tant qu'il ne s'est jamais présenté. */
  lastSeenAt: string | null;
  /** Dernier remplacement de la connexion par une plus récente (journal du lien), ISO. */
  lastReplacedAt: string | null;
  /**
   * Dernier remplacement suspect : depuis une autre adresse, ou trois
   * remplacements en dix minutes. L'écran le montre en bandeau et propose de
   * faire tourner le jeton.
   */
  hijackSuspectedAt: string | null;
  /** Dernière rotation du jeton de lien, ISO ; `null` si jamais tourné. */
  rotatedAt: string | null;
  /**
   * Origine HTTPS (loopback HTTP en dev) signée à la dernière preuve.
   * `null` tant qu'aucune preuve n'a été enregistrée (0110).
   */
  origin: string | null;
  /** Cette origine n'est plus parmi celles que ce déploiement accepte. */
  originRetired: boolean;
  /**
   * `edge-setup link --ohb <origine actuelle> --yes`, seulement quand
   * `originRetired` : sans ticket, la commande seule ne suffit pas.
   */
  relinkCommand: string | null;
};

/**
 * `POST /api/runtime/:id/link/verify` : ping WebSocket natif du lien, puis sonde
 * du gateway si le lien répond.
 *
 * - `alive` : pong reçu (`rttMs`), ou trame reçue sans pong (`rttMs: null`) ;
 *   `gateway` dit si Hermes répond derrière.
 * - `reconnect_requested` : rien reçu, openedbot a raccroché (4005) ; l'hôte redial.
 *   Attendre une `link.generation` différente de `generation`, puis revérifier.
 * - `generation_changed` : l'hôte s'est déjà reconnecté ; revérifier.
 * - `indeterminate` : ping non parti (lien saturé).
 * - `no_link` / `owner_unavailable` : openedbot ne peut pas joindre l'hôte.
 */
type RuntimeLinkVerifyOutcome =
  | "alive"
  | "reconnect_requested"
  | "generation_changed"
  | "indeterminate"
  | "no_link"
  | "owner_unavailable";

export type RuntimeLinkVerifyDto = {
  runtimeId: string;
  outcome: RuntimeLinkVerifyOutcome;
  /** Le bail sondé ; `null` sans lien. */
  generation: string | null;
  rttMs: number | null;
  /** Sonde du gateway, seulement quand le lien répond. */
  gateway: { ok: true } | { ok: false; code: string; message: string } | null;
  /** Dernier signe de vie connu et dernière erreur écrite, pour dire depuis quand. */
  lastSeenAt: string | null;
  lastHealthError: string | null;
};

type RuntimeLinkEventKind ="connected" | "replaced" | "disconnected" | "revoked" | "rotated" | "device_key_registered" | "hijack_suspected" | "agent_outdated";

type RuntimeLinkEventMetadata = {
  minimum?: string;
  instanceId?: string | null;
  generation?: string | null;
  closeCode?: number;
  closeReason?: string;
  ownershipCurrent?: boolean | null;
};

type RuntimeLinkEventDto = {
  id: string;
  kind: RuntimeLinkEventKind;
  ip: string | null;
  agent: string | null;
  previousIp: string | null;
  occurredAt: string | null;
  meta?: RuntimeLinkEventMetadata;
};

export type RuntimeLinkEventsDto = { events: RuntimeLinkEventDto[] };

/**
 * `maintenance` : grâce de dix minutes pour l'ancien jeton, nouveau jeton poussé
 * sur le lien ouvert. `emergency` : aucune grâce, aucun push (la connexion
 * ouverte peut être celle d'un détourneur), lien fermé 4401 : le jeton se pose
 * à la main sur l'hôte.
 */
export type RuntimeLinkRotationMode = "maintenance" | "emergency";

/** Réponse de `POST /api/runtime/:runtimeId/link/rotate` : le jeton n'est rendu qu'ici, une fois. */
export type RuntimeLinkRotationDto = {
  linkToken: string;
  runtimeId: string;
  mode: RuntimeLinkRotationMode;
  /** Le nouveau jeton est parti `link.rotate` sur le lien ouvert (jamais en `emergency`). */
  pushed: boolean;
  /** Fin de la grâce de l'ancien jeton, ISO ; `null` en `emergency`. */
  expiresPreviousAt: string | null;
};
