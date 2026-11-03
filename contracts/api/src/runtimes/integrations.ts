import type { BotSkillDto } from "../roster/capabilities";
import type { RuntimeProviderOauthStatus } from "./providers";

/**
 * Inventaire en lecture seule des outils réellement déclarés par Hermes.
 *
 * `configured` reprend mot pour mot le signal de `/v1/toolsets` : il ne
 * prouve PAS à lui seul qu'un compte OAuth est connecté. Selon le toolset, la
 * configuration manquante peut être une clé, un binaire, un endpoint ou une
 * autre dépendance. Garder ce nom évite de transformer ce signal en faux état
 * d'authentification dans les clients.
 */
export type RuntimeIntegrationToolsetDto = {
  name: string;
  label: string;
  description: string | null;
  status: "ready" | "configuration_required" | "disabled";
  enabled: boolean;
  configured: boolean;
  tools: string[];
  /**
   * `true` quand l'hôte accepte d'écrire ce toolset sur sa plateforme
   * `api_server`. Distinct de `enabled` : un toolset restreint à une autre
   * plateforme se lit dans l'inventaire mais l'écriture amont le laisserait
   * tomber en silence : l'écran doit donc afficher son état sans interrupteur.
   *
   * `false` aussi quand le runtime n'offre aucun canal d'écriture : dans ce cas
   * `management.writable` est `false` et la page reste en lecture seule.
   */
  settable: boolean;
  /**
   * `true` quand le contrat openedbot refuse ce toolset (`FORBIDDEN_TOOLSETS`).
   * Il ne s'active jamais, ni ici ni sur l'hôte ; il ne se désactive.
   */
  forbidden: boolean;
};

/** Le résultat d'une bascule, RELU par l'hôte sur `/v1/toolsets`. */
export type RuntimeIntegrationToolsetStateDto = {
  name: string;
  enabled: boolean;
  requested: boolean;
  /** `false` = l'hôte a écrit, et l'inventaire dit toujours le contraire. */
  applied: boolean;
};

export type RuntimeIntegrationMcpServerDto = {
  name: string;
  transport: "http" | "stdio" | "unknown";
  /** Une localisation, jamais un credential. */
  endpoint: string | null;
  command: string | null;
  auth: "none" | "header" | "oauth";
  /** Activé dans la configuration du runtime. */
  configEnabled: boolean;
  /** Porté par la plateforme que les runs openedbot utilisent. */
  platformEnabled: boolean;
  toolsIncluded: string[] | null;
  toolsExcluded: string[] | null;
  /** Noms des variables d'environnement, jamais leurs valeurs. */
  envKeys: string[];
  /** Outils vus à la sonde d'ajout ; `null` en dehors de cet aller. */
  discoveredTools: string[] | null;
  /** L'hôte a enregistré le serveur mais n'a pas pu le joindre. */
  unreachable: boolean;
  /**
   * Serveur `oauth` : l'hôte détient-il un jeton sur le disque (jamais son
   * contenu). `null` pour les autres modes, et pour un hôte plus ancien qui
   * ne le dit pas. Sans jeton, le serveur est inerte : aucun outil ne sera
   * jamais listé, quel que soit le badge « porté par la plateforme ».
   */
  oauthTokenPresent: boolean | null;
};

export type RuntimeIntegrationMcpCatalogEntryDto = {
  name: string;
  description: string | null;
  source: string | null;
  authType: string;
  authProvider: string | null;
  transport: "http" | "stdio";
  requiresInstall: boolean;
  envSpecs: { name: string; description: string | null; required: boolean; secret: boolean }[];
};

/**
 * Les serveurs MCP de l'hôte et le catalogue approuvé qu'il porte, rendus par
 * `GET /api/runtime/integrations/mcp`.
 *
 * Cette lecture est SÉPARÉE de l'inventaire : elle démarre un interpréteur sur
 * l'hôte, et seul le panneau d'administration des connecteurs en a besoin. La
 * fondre dans la page en ferait payer le prix à chaque affichage de l'écran.
 *
 * `available` est `false` quand le runtime n'offre pas `mcp_management` : la
 * page dit alors ce qu'elle ne peut pas faire, plutôt que d'afficher une liste
 * vide qu'on lirait comme « aucun connecteur ».
 */
export type RuntimeIntegrationMcpDto = {
  available: boolean;
  /**
   * Ce que l'hôte annonce en plus de `mcp_management` : `oauth` (les quatre
   * verbes d'autorisation d'un serveur `auth: oauth`) et `gatewayRestart`
   * (l'état du gateway et le seul redémarrage que le lien porte). Un hôte qui
   * ne l'annonce pas ne reçoit aucun bouton.
   */
  capabilities: { oauth: boolean; gatewayRestart: boolean };
  servers: RuntimeIntegrationMcpServerDto[];
  catalog: RuntimeIntegrationMcpCatalogEntryDto[];
  error: { code: string; message: string } | null;
};

/**
 * Une autorisation OAuth d'un serveur MCP, jouée sur l'hôte avec ce
 * navigateur pour seule jambe humaine : `authorizationUrl` s'ouvre dans un
 * onglet, le fournisseur renvoie le navigateur vers l'API, qui relaie le
 * callback à l'hôte. `connected` seulement quand l'hôte a relu un jeton sur son
 * disque et listé les outils avec lui.
 */
/** Le retrait d'une entrée du catalogue d'un bot (configuration du profil et jetons). */
export type RuntimeMcpDisconnectDto = {
  connector: string;
  botId: string;
  /** `false` : le profil ne portait déjà plus ce serveur. */
  removed: boolean;
  /** L'hôte a effacé les jetons du profil pour ce serveur (ou n'en avait aucun). */
  tokensRemoved: boolean;
};

export type RuntimeMcpOauthDto = {
  sessionId: string;
  server: string;
  status: RuntimeProviderOauthStatus;
  authorizationUrl: string | null;
  error: string | null;
  errorCode: string | null;
  discoveredTools: string[];
  expiresAt: string;
};

export type RuntimeGatewayRestartDto = {
  jobId: string;
  status: "running" | "ok" | "failed";
  /** `restart` : l'unité redémarre ; `health` : on attend `/health` ; `done`. */
  step: "restart" | "health" | "done";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  expiresAt: string;
};

/**
 * The gateway state as the host reports it. The gateway reads its
 * configuration at startup only: `restartPending` says that a change it has
 * not loaded yet landed since (an MCP write or OAuth authorization, a
 * per-profile MCP toggle, an A2A peer token write, or an edge-setup upgrade
 * that changed the gateway unit's directives while runs were in progress), so
 * runs do not see it.
 */
export type RuntimeGatewayStatusDto = {
  restartPending: boolean;
  pendingSince: string | null;
  activeSince: string | null;
  job: RuntimeGatewayRestartDto | null;
};

export type RuntimeIntegrationInventoryDto = {
  runtime: { id: string; name: string } | null;
  /** `null` = endpoint d'inventaire absent ou lecture impossible, jamais « aucun outil ». */
  toolsets: RuntimeIntegrationToolsetDto[] | null;
  /** `null` = ce build Hermes n'expose pas `/v1/skills`, ou sa lecture a échoué (`skillsError`). */
  skills: BotSkillDto[] | null;
  /** `/v1/skills` existe mais a échoué côté runtime ; les toolsets restent lisibles. */
  skillsError: { code: string; message: string } | null;
  support: "available" | "partial" | "unavailable";
  totals: {
    /** `null` = inventaire toolsets absent; zéro = inventaire présent et aucun résultat. */
    ready: number | null;
    configurationRequired: number | null;
    disabled: number | null;
    tools: number | null;
    /** `null` = endpoint skills absent; zéro = endpoint présent et liste vide. */
    skills: number | null;
  };
  /** Diagnostic public fermé : jamais de corps upstream, URL, token ou identifiant interne. */
  inventoryError: { code: string; message: string } | null;
  management: {
    /**
     * `true` quand l'hôte annonce `toolset_management` / `mcp_management` :
     * openedbot écrit alors par l'opérateur edge-setup, sur le canal HTTPS déjà
     * authentifié, sans jamais ouvrir de session shell vers la machine.
     *
     * `false` reste le cas honnête d'avant : le gateway ne publie pas les
     * routes d'administration MCP, et rien ne s'écrit depuis ici.
     */
    writable: boolean;
    /** Ce que l'hôte sait faire, tel qu'il l'a annoncé. */
    capabilities: { toolsets: boolean; mcp: boolean };
    owner: "hermes";
    canConfigure: boolean;
    settingsPath: "/settings/runtime";
    /** Résultat de la sonde GET du gateway ; elle ne décide plus de l'écriture. */
    status:
      | "runtime_missing"
      | "not_exposed"
      | "runtime_token_not_accepted"
      | "read_endpoint_available"
      | "unavailable";
    serverCount: number | null;
  };
  observedAt: string;
};
