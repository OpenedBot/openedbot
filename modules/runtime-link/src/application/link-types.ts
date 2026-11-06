import type { RelayAuditAnchorFrame, RelayDiagnosticFrame } from "@openedbot/contracts-connector";
import type { AnchorWrite } from "./audit-keys";
import { LINK_RECONNECT_REASON } from "@openedbot/runtimes/domain/link-probe";

/**
 * Ce que le broker attend d'un WebSocket serveur: `Bun.ServerWebSocket` s'y
 * conforme. `send` rend le verdict de Bun : `-1` mis en file sous
 * backpressure (accepté), `0` message ABANDONNÉ (jamais parti), `> 0` octets
 * écrits. Ignorer ce verdict, c'est laisser partir un corps tronqué suivi d'un
 * `end` propre.
 */
export type LinkSocket = {
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  /** Ping WebSocket natif, charge utile rendue par le pong (même verdict que `send`). */
  ping?(data?: string | Uint8Array): number;
};

/** Ce qu'une connexion sait de sa propre sonde, avant que le broker en tire un verdict. */
export type ConnectionProbe = { alive: true; rttMs: number | null } | { alive: false; reason: "timeout" | "closed" | "indeterminate" };

/** Le runtime qu'une connexion représente, une fois liée. */
export type LinkIdentity = {
  runtimeId: string;
  organizationId: string;
  /** SHA-256 du jeton de lien : la porte RLS `runtimes_link_credential`, jamais le jeton. */
  tokenHash: string;
  /** Immutable database reservation for this socket; decimal bigint on the wire. */
  generation?: string;
  /**
   * Monté avec l'ANCIEN jeton pendant la grâce d'une rotation (0027) : l'instant
   * (ms epoch) où cette connexion doit se fermer 4401 `LINK_TOKEN_EXPIRED`.
   * `null` pour le jeton courant.
   */
  expiresAt: number | null;
};

/** D'où l'hôte parle : l'adresse vue à la montée et son `User-Agent`. Journal et événements seulement. */
export type LinkPeer = {
  ip: string | null;
  agent: string | null;
};

/** Les événements du journal du lien connecteur. */
export type LinkEventKind =
  | "connected" | "replaced" | "disconnected" | "revoked" | "rotated" | "hijack_suspected"
  | "device_key_registered" | "pop_failed" | "pop_missing" | "unattributed_session" | "clock_skew"
  | "worm_write_failed" | "anchor_tampered" | "agent_outdated";

/** Un `POST /v1/runs` relayé par le broker : le jumeau côté API de l'audit du connecteur. */
export type LinkDispatchRecord = {
  /** SHA-256 de l'`Idempotency-Key` relayée ; `null` quand le worker n'en a pas posé. */
  idempotencyKeyHash: string | null;
  dispatchedAt: Date;
  /** Statut de la réponse du gateway ; `null` quand le lien est tombé avant (`ambiguous`). */
  status: number | null;
  /** `run_id` lu sur la réponse JSON bornée, quand elle en porte un. */
  remoteId: string | null;
};

export type LinkEventMeta = {
  /** Seuil minimal ayant déclenché le signalement d'obsolescence. */
  minimum?: string;
  ip?: string | null;
  agent?: string | null;
  previousIp?: string | null;
  instanceId?: string | null;
  generation?: string | null;
  closeCode?: number;
  closeReason?: string;
  /** DB ownership at the close write; null means persistence could not establish it. */
  ownershipCurrent?: boolean | null;
  /** Rotation déclenchée par le broker lui-même (deux sockets valides, adresses différentes). */
  automatic?: boolean;
  reason?: string;
  /** Ancre rejouée en recul : la clé et la position que l'hôte a présentées. */
  keyId?: string;
  writeSeq?: number;
};

/** Les écritures de vitalité (`link_*`, `last_health_status`), injectables dans les tests. */
export class LinkLeaseLostError extends Error {
  constructor() { super("Runtime link lease was superseded or released"); this.name = "LinkLeaseLostError"; }
}

/** Les fermetures décidées par openedbot, par leur raison de fermeture WebSocket. */
const LINK_CLOSURE_MESSAGES: Record<string, string> = {
  LINK_REPLACED: "Le lien a été remplacé par une nouvelle instance de l’hôte.",
  LINK_REVOKED: "Le runtime a été révoqué ; openedbot a fermé le lien.",
  LINK_RETIRED: "L’hôte s’est retiré (désinstallation) ; openedbot a révoqué ce runtime.",
  LINK_ROTATED: "Le jeton du lien a été tourné ; l’hôte doit se reconnecter.",
  LINK_TOKEN_EXPIRED: "Le jeton du lien a expiré ; l’hôte doit se reconnecter.",
  LINK_LEASE_LOST: "Le bail du lien a été perdu : une autre connexion tient ce runtime.",
  LINK_CLAIM_FAILED: "L’admission du lien a échoué côté openedbot.",
  LINK_ADMISSION_FAILED: "L’admission du lien a échoué côté openedbot.",
  LINK_POP_FAILED: "La preuve de possession de l’hôte a échoué ; openedbot a fermé le lien.",
  LINK_SEND_FAILED: "L’envoi vers l’hôte a échoué ; openedbot a fermé le lien.",
  HERMES_PROTOCOL_LIMIT: "L’hôte a envoyé une trame trop grande ; openedbot a fermé le lien.",
  SERVER_SHUTDOWN: "openedbot a redémarré ; l’hôte ne s’est pas reconnecté depuis.",
  GATEWAY_SHUTDOWN: "openedbot a redémarré ; l’hôte ne s’est pas reconnecté depuis.",
  LINK_DRAIN_TIMEOUT: "openedbot a redémarré avant la fin du drainage ; l’hôte ne s’est pas reconnecté depuis.",
  [LINK_RECONNECT_REASON]: "Le lien ne répondait plus au ping ; openedbot l’a fermé pour que l’hôte se reconnecte.",
};

/**
 * La phrase que l'écran Runtime montre sous « lien connecteur fermé » : une
 * raison connue d'openedbot est nommée ; sinon c'est l'hôte (ou le réseau) qui a
 * fermé, et seul le code est repris, jamais le texte libre de l'hôte.
 */
export function describeLinkClosure(code: number, reason: string): string {
  // `reason` vient de la trame de fermeture : « constructor » ou « __proto__ »
  // ne doivent pas remonter une propriété héritée à la place d'une phrase.
  if (Object.hasOwn(LINK_CLOSURE_MESSAGES, reason)) return LINK_CLOSURE_MESSAGES[reason]!;
  if (code === 1006) return "Le lien s’est interrompu sans trame de fermeture (code 1006).";
  return `L’hôte a fermé le lien (code ${code}).`;
}

export type LinkLivenessStore = {
  /** Reserve once before admission. A failed reservation requires a fresh socket. */
  reserveGeneration?(link: LinkIdentity): Promise<string>;
  /** `features` : ce que l'hôte a annoncé dans `hello` (0026 `link_features`), réécrit à chaque connexion. */
  connected(link: LinkIdentity, instanceId: string, features: string[]): Promise<void>;
  diagnostic?(link: LinkIdentity, frame: RelayDiagnosticFrame, receiverInstanceId?: string): Promise<void>;
  /**
   * `link.retire` : l'hôte se retire (désinstallation). Révoque le runtime du
   * jeton courant comme `DELETE /api/runtime/:id` (événement `revoked`).
   */
  retire?(link: LinkIdentity, instanceId?: string): Promise<void>;
  /** Heartbeat only for the exact live lease; a cleared/superseded owner must reconnect. */
  seen(link: LinkIdentity, instanceId: string): Promise<void>;
  /** Refresh host capabilities without replacing the live connection. */
  capabilities?(link: LinkIdentity, instanceId: string, features: string[]): Promise<void>;
  /**
   * `reason` : une phrase courte, lisible par l'opérateur, écrite dans
   * `last_health_error` à côté de `disconnected` (voir `describeLinkClosure`).
   */
  disconnected(link: LinkIdentity, instanceId: string | undefined, reason: string): Promise<void>;
  /** Journal `runtime_link_events` (0027). Optionnel : absent, rien n'est journalisé. */
  event?(link: LinkIdentity, kind: LinkEventKind, meta: LinkEventMeta): Promise<void>;
  /** Dernière ancre de l'audit scellé (0052) ; `regressed` quand l'hôte rejoue une position ancienne. */
  auditAnchor?(link: LinkIdentity, frame: RelayAuditAnchorFrame): Promise<AnchorWrite>;
  /** Journal de dispatch (0052) : un enregistrement par création relayée, statut et run_id compris. */
  dispatched?(link: LinkIdentity, record: LinkDispatchRecord, instanceId: string): Promise<void>;
  /**
   * Bump `runtimes.toolset_epoch` after a relayed host write that can
   * change the toolset inventory, so the worker's inventory cache re-reads.
   */
  toolsetsWritten?(link: LinkIdentity): Promise<void>;
  /**
   * 0163 : une écriture relayée a changé les capacités d'un profil (`profile`)
   * ou de la racine (`null`). Marque le runtime ; le fil dont la session
   * Hermes est plus ancienne passe à une session neuve au message suivant.
   */
  capabilitiesWritten?(link: LinkIdentity, profile: string | null): Promise<void>;
  /**
   * `inventory.changed` : l'hôte dit que les fichiers derrière son inventaire
   * ont bougé (ou la session commence). Marque `runtimes.inventory_changed_at` ;
   * `true` quand la ligne de ce jeton existe encore.
   */
  inventoryChanged?(link: LinkIdentity): Promise<boolean>;
  /**
   * Rotation d'urgence automatique : deux sockets valides d'adresses
   * différentes en dix minutes. Le nouveau hash n'est remis à personne ; le
   * lien se relie par un nouvel enrôlement.
   */
  emergencyRotate?(link: LinkIdentity, meta: LinkEventMeta): Promise<void>;
};

export type LinkLogger = (event: string, fields: Record<string, unknown>) => void;

export type RuntimeLinkBrokerOptions = {
  instanceId: string;
  liveness: LinkLivenessStore;
  now?: () => number;
  /** `req` → premier `res`, sauf pour la route `events` (défaut 60 s). */
  firstResponseTimeoutMs?: number;
  /** Flux `events` sans octet (défaut 15 min). */
  eventsIdleTimeoutMs?: number;
  /** `ping` applicatif (défaut 15 s), en plus des pings WebSocket de Bun. */
  pingIntervalMs?: number;
  /** Écriture de `link_last_seen_at` au plus une fois par fenêtre (défaut 10 s). */
  seenDebounceMs?: number;
  log?: LinkLogger;
  /**
   * Après qu'un `inventory.changed` a été inscrit : l'application relit
   * l'inventaire de ce runtime en arrière-plan (l'API dans son processus, la
   * passerelle séparée par un signal à l'API).
   */
  onInventoryChanged?: (link: LinkIdentity) => void;
};

export type ConnectionOptions = Required<Omit<RuntimeLinkBrokerOptions, "liveness" | "instanceId" | "onInventoryChanged">> & {
  liveness: LinkLivenessStore;
  instanceId: string;
  onInventoryChanged?: (link: LinkIdentity) => void;
};
