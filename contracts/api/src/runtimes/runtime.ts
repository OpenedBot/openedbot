import type { RuntimeReachability } from "./connector";
import type { RuntimeExposureStoredKind } from "./exposures";
import type { RuntimeLinkDto } from "./link";
import type { RuntimeModelSelectionStateDto } from "./models";
import type { HermesReasoningEffort } from "./reasoning-effort";
import type { RuntimeHealthStatus } from "../shared/domain";

export type RuntimePublicDto = {
  id: string | null;
  configured: boolean;
  /** `null` pour un runtime `connector` : aucune URL n'existe côté cloud. */
  baseUrl: string | null;
  reachability: RuntimeReachability;
  /** @deprecated Alias de `reachability`, conservé une version pour les clients antérieurs. */
  transport: RuntimeReachability;
  /** État du lien connecteur ; `null` pour un runtime `direct`. */
  link: RuntimeLinkDto | null;
  management: {
    /**
     * `hermes_dashboard` : le Hermes intégré de ce déploiement, écrit via son
     * Dashboard local. `host` : l'hôte du client offre l'opérateur
     * edge-setup (`provider_management`, annoncé dans `hello` par le lien
     * ou sondé sur `GET /hermes-setup/capabilities` en direct) ; les
     * écritures fournisseur (clé API, OAuth) partent vers cet opérateur : par
     * le lien connecteur, ou en HTTPS avec le bearer du gateway : jamais par
     * SSH. Par le lien, `*Writable` reste faux tant qu'il n'est pas ouvert.
     * `manual` : openedbot n'administre pas ce runtime et l'écran renvoie
     * vers le geste à jouer sur la machine du client.
     */
    kind: "hermes_dashboard" | "host" | "manual";
    credentialsWritable: boolean;
    oauthWritable: boolean;
  };
  name: string | null;
  /** @deprecated Conservé pour les clients antérieurs au multi-runtime : lire `isActive`. */
  isDefault: boolean;
  /** Le runtime qui sert les runs. Au plus un par organisation, garanti en base. */
  isActive: boolean;
  tokenConfigured: boolean;
  /** OHB-74 : un service token Cloudflare Access est enregistré pour ce runtime `direct`. Absent sur les serveurs antérieurs. */
  edgeAuthConfigured?: boolean;
  /**
   * OHB-75 : la publication qui a produit cette ligne `direct`, si elle est passée
   * par l'assistant ; `null` pour un accès déclaré à la main ou un `connector`.
   */
  exposure?: { id: string; kind: RuntimeExposureStoredKind; hostname: string; lastTunnelStatus: string | null } | null;
  botCount: number;
  selectedProvider: string | null;
  selectedModel: string | null;
  reasoningEffort: HermesReasoningEffort | null;
  detectedVersion: string | null;
  capabilities: Record<string, unknown> | null;
  /** Features announced by the authenticated runtime link/host operator. */
  /** Absent on responses from servers before runtime feature advertisement. */
  linkFeatures?: string[];
  capacity?: number;
  lastHealthStatus: RuntimeHealthStatus;
  lastHealthError?: string | null;
  lastCheckedAt: string | null;
  createdAt?: string | null;
  updatedAt: string | null;
  /**
   * Réécriture du bloc `model` des profils gérés qui suivent le runtime
   * (bots sans modèle propre). Absent si aucun profil n'était concerné.
   */
  profileModel?: { applied: boolean };
  /**
   * Choix de modèle enregistré mais pas encore prouvé (test d'inférence en
   * arrière-plan, worker). `selected*` ci-dessus reste le modèle EN SERVICE
   * jusqu'au succès; `null` quand aucune preuve n'est en cours ni en échec.
   * Absent sur les serveurs antérieurs.
   */
  modelSelection?: RuntimeModelSelectionStateDto | null;
  /**
   * Incidents quota/auth encore actifs sur ce runtime. Absent sur les
   * serveurs antérieurs à 0046 ; un tableau vide veut dire « aucun ».
   */
  providerIncidents?: RuntimeProviderIncidentDto[];
};

type RuntimeProviderIncidentKind = "quota" | "auth";

export type RuntimeProviderIncidentDto = {
  provider: string;
  kind: RuntimeProviderIncidentKind;
  firstSeenAt: string;
  lastSeenAt: string;
  until: string;
  fallbackProvider: string | null;
  fallbackModel: string | null;
  message: string | null;
};
