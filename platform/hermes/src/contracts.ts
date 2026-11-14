import type { EndpointPolicy } from "./endpoint";
import type { HermesMtlsIdentity } from "./mtls";
import type { HermesTransport } from "./transport/types";
import type { HermesMcpAuth, HermesProfileMcpServer, HermesProfileNamedFlag } from "./host-profile-flags";
export type { A2aAgentCard } from "@openedbot/contracts-connector";

/** Public input/output contracts for the Hermes client. */
/**
 * Per-call timeouts of the run executor surface, in milliseconds. Each one
 * falls back to its default and is bounded to a safe integer of at most ten
 * minutes. The client never reads the environment: callers pass these in.
 */
export type HermesClientTimeouts = {
  /** `POST /v1/runs`. */
  createRunMs: number;
  /** `GET /v1/runs/{id}`. */
  runStatusMs: number;
  /** `GET /api/sessions/{id}`. */
  sessionCountersMs: number;
  /** `GET /api/sessions/{id}/messages`. */
  sessionMessagesMs: number;
  /** Stop, steer, approval, session create and delete. */
  mutationMs: number;
};

export type HermesDirectClientConfig = {
  endpoint: string;
  token: string;
  policy: EndpointPolicy;
  mtls: HermesMtlsIdentity | null;
  profile?: string | null;
  timeouts?: Partial<HermesClientTimeouts>;
};

export type HermesTransportClientConfig = {
  transport: HermesTransport;
  profile?: string | null;
  timeouts?: Partial<HermesClientTimeouts>;
};

export type HermesClientConfig = HermesDirectClientConfig | HermesTransportClientConfig;

export type { CreateHermesRunInput, HermesPromptCacheTtl, HermesRunImage } from "./run-input";

export type SteerHermesRunInput = {
  text: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export const HERMES_RUN_STATUSES = [
  "queued",
  "started",
  "running",
  "stopping",
  "waiting_for_approval",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  /**
   * Hermes 0.23: the process that ran the turn vanished mid-turn. Not
   * terminal: the session's next turns wait until
   * `POST /v1/runs/{id}/resolve-unknown`. Hermes 0.22 never reports it.
   */
  "unknown",
] as const;

export type HermesRunStatus = typeof HERMES_RUN_STATUSES[number];

export type HermesRunDetails = {
  id: string;
  status: HermesRunStatus;
  output: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
  /**
   * Le texte des `/steer` que l'agent n'a JAMAIS lus : un steer n'est livré
   * qu'à la frontière d'outil suivante, et quand la réponse finale tombe
   * avant, l'amont le rend ici (`pending_steer`, sur le statut comme sur
   * `run.completed`) pour que le client le rejoue en tour suivant. Plusieurs
   * textes sont concaténés par « \n », dans l'ordre d'arrivée.
   */
  pendingSteer: string | null;
  /**
   * Hermes 0.23 session admission of the run and its execution generation:
   * the pair `resolve-unknown` needs. Null on Hermes 0.22.
   */
  admissionId?: string | null;
  executionGeneration?: number | null;
};

export type HermesSessionCounters = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type HermesModelOption = { id: string; fast: boolean; reasoning: boolean };

export type HermesModelProvider = {
  slug: string;
  name: string;
  isCurrent: boolean;
  authenticated: boolean;
  authType: string | null;
  warning: string | null;
  models: HermesModelOption[];
};

export type HermesModelOptions = {
  provider: string | null;
  model: string | null;
  providers: HermesModelProvider[];
};

export type HermesProviderVerification = "confirmed" | "denied" | "unverified";

export type HermesProviderCredentialResult = {
  provider: string;
  label: string;
  verification: HermesProviderVerification;
  detail: string | null;
};

export type HermesProviderOauthStatus = "starting" | "pending" | "connected" | "failed" | "cancelled";

export type HermesProviderOauthSession = {
  sessionId: string;
  provider: string;
  status: HermesProviderOauthStatus;
  verificationUri: string | null;
  userCode: string | null;
  error: string | null;
  expiresAt: string;
};

export type HermesProviderUsageWindow = {
  label: string;
  usedPercent: number | null;
  resetAt: string | null;
  detail: string | null;
};

export type HermesProviderUsageSnapshot = {
  provider: string;
  source: "oauth_usage_api" | "usage_api" | "credits_api" | "api_key" /* clé à l'usage, sans forfait */ | "unsupported" | "unavailable";
  plan: string | null;
  windows: HermesProviderUsageWindow[];
  details: string[];
  unavailableReason: string | null;
};

export type HermesProviderUsageDocument = { fetchedAt: string; providers: HermesProviderUsageSnapshot[] };

/**
 * La fenêtre de contexte du modèle qu'un runtime applique réellement.
 *
 * `effectiveContextLength` est le nombre que l'agent applique : la valeur
 * configurée quand il y en a une, la valeur détectée sinon. `0` veut dire
 * inconnue, jamais zéro jeton : un appelant qui lit `0` retombe sur sa propre
 * table plutôt que de dessiner une barre pleine.
 */
export type HermesModelContext = {
  profile: string | null;
  model: string | null;
  provider: string | null;
  autoContextLength: number;
  configContextLength: number;
  effectiveContextLength: number;
  maxOutputTokens: number;
  /** Le préambule que le gateway ajoute à chaque run ; `null` pour un hôte plus ancien. */
  preamble: HermesContextPreamble | null;
};

/** Les postes du préambule, dans l'ordre fixe où l'hôte les publie. */
export type HermesPreambleKey = "identity" | "memory" | "skills" | "tools" | "mcp";

/** `tokens: null` : présent mais non mesuré (schémas MCP), jamais zéro. */
export type HermesPreambleItem = { name: string; tokens: number | null };

export type HermesPreambleBucket = {
  key: HermesPreambleKey;
  tokens: number | null;
  items: HermesPreambleItem[];
};

export type HermesContextPreamble = { buckets: HermesPreambleBucket[] };

export type HermesToolset = {
  name: string;
  label: string;
  description: string | null;
  enabled: boolean;
  configured: boolean;
  tools: string[];
};

export type HermesSkill = { name: string; description: string | null; category: string | null };

export type HermesProfileIsolation = "isolated" | "missing" | "not_partitioned";

export type HermesCapabilityInventory = {
  toolsets: HermesToolset[] | null;
  /** `null` : `/v1/skills` absent (404) ou en échec (`skillsFailed`). */
  skills: HermesSkill[] | null;
  /**
   * `/v1/skills` existe mais n'a pas répondu proprement (5xx, délai, corps
   * invalide). Les skills sont une section optionnelle : leur échec ne fait
   * pas tomber l'inventaire des toolsets, il se dit à part. Absent : `false`.
   */
  skillsFailed?: boolean;
};

export type HermesConnectorManagementProbe = {
  status: "not_exposed" | "runtime_token_not_accepted" | "read_endpoint_available";
  serverCount: number | null;
};

export type {
  A2APolicyAccessMode,
  A2APolicyDecision,
  A2APolicyPeer,
  A2APolicyTrustedPeersSource,
  A2APolicyView,
  A2APolicyWriteStatus,
} from "./a2a-policy-types";

/**
 * Ce que l'hôte accepte d'écrire, par la route HÔTE `GET /hermes-setup/toolsets`.
 *
 * `settable` ne double pas `/v1/toolsets` : le gateway dit l'état de chaque
 * toolset, l'hôte dit lesquels sa plateforme `api_server` peut porter. Un
 * toolset absent de cette liste serait silencieusement ignoré par l'écriture
 * amont : l'afficher avec un interrupteur mentirait.
 */
export type HermesHostToolsets = {
  platform: string;
  settable: string[];
  /**
   * Par toolset, ses outils sont-ils appelables sur cet hôte, d'après le
   * registre Hermes lui-même (`is_toolset_available`, les `check_fn`), ce que
   * `/v1/toolsets` ne dit pas. `null` : l'hôte ne sert pas le champ (edge-setup
   * plus ancien) ; jamais « tout disponible ».
   */
  availability: HermesToolsetAvailability[] | null;
};

/** Raisons fermées qu'un hôte peut donner d'un toolset indisponible. */
export const TOOLSET_UNAVAILABLE_REASONS = ["credentials_missing", "check_failed"] as const;
export type HermesToolsetUnavailableReason = (typeof TOOLSET_UNAVAILABLE_REASONS)[number];

export type HermesToolsetAvailability = {
  name: string;
  /** `null` : non mesuré (toolset inconnu du registre, ou Hermes sans cette fonction). */
  available: boolean | null;
  /** Renseignée seulement quand `available` est `false`. */
  reason: HermesToolsetUnavailableReason | null;
};

/**
 * Le connecteur SDK d'un fournisseur sur l'hôte, par la route HÔTE
 * `GET /hermes-setup/provider-sdks` (feature `provider_sdks`). Hermes 0.22
 * installe les SDK à la demande et edge-setup coupe cette installation : un
 * fournisseur connecté dont le SDK manque échoue à chaque run.
 */
/** `installable`: `edge-setup up` installs this SDK; otherwise no openedbot-supported install provides it. */
export type HermesProviderSdk = { provider: string; label: string; extra: string; installed: boolean; installable: boolean };

export type HermesProfileModel = {
  default: string | null;
  provider: string | null;
};

export type HermesProfileUiMeta = {
  title: string | null;
  color: string | null;
  shape: string | null;
  imageKind: string | null;
  hidden: boolean;
  pinned: boolean;
  sectionId: string | null;
  groups: string[];
  created: string | null;
};

export type HermesProfileRoutine = {
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  deliver: boolean;
  model: string | null;
};

/**
 * Un profil Hermes nommé, hors `default`. Pas de `.env`, de mémoire ni de
 * session. Skills / toolsets : nom et état activé ; MCP : `HermesProfileMcpServer`.
 */
export type HermesHostProfile = {
  name: string;
  displayName: string;
  title: string | null;
  description: string | null;
  soul: string | null;
  model: HermesProfileModel;
  uiMeta: HermesProfileUiMeta | null;
  hasAvatar: boolean;
  routines: HermesProfileRoutine[];
  skills: HermesProfileNamedFlag[];
  toolsets: HermesProfileNamedFlag[];
  mcpServers: HermesProfileMcpServer[];
  /** L'hôte décrit les entrées MCP du profil : une liste vide dit « aucun serveur ». Absent : hôte plus ancien. */
  mcpFacts?: true;
};

/**
 * Réponse à la création : le profil, et `readBack: "profile"` quand l'hôte l'a
 * relu lui-même après écriture (nom listé, modèle demandé présent). Un hôte
 * plus ancien n'envoie pas la marque : la preuve reste l'inventaire complet.
 */
export type HermesCreatedHostProfile = HermesHostProfile & { readBack?: "profile" };

export type HermesProfileInventory = { profiles: HermesHostProfile[] };

export type HermesProfileAvatarContentType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type HermesProfileAvatar = {
  contentType: HermesProfileAvatarContentType;
  bytes: Uint8Array;
};

/**
 * Le résultat d'une bascule de toolset, RELU sur `/v1/toolsets` par l'hôte.
 *
 * `enabled` est l'état constaté, jamais celui demandé : `hermes tools` imprime
 * ses refus et sort quand même en 0, et `agent.disabled_toolsets` peut annuler
 * une activation. `applied` dit si les deux coïncident.
 */
export type HermesToolsetState = {
  name: string;
  platform: string;
  enabled: boolean;
  requested: boolean;
  applied: boolean;
};

/** Résultat relu d'une bascule de toolset dans un profil nommé. */
export type HermesProfileToolsetState = HermesToolsetState & { profile: string };

/** Les deux cibles du magasin de mémoire amont : `MEMORY.md` et `USER.md`. */
export type HermesMemoryTarget = "memory" | "user";

/**
 * La mémoire d'un profil nommé, telle que le magasin amont la lit : les
 * entrées de `MEMORY.md` et `USER.md`, les caractères consommés, les plafonds
 * du profil et ses deux drapeaux. Les fichiers eux-mêmes ne traversent pas.
 */
export type HermesProfileMemory = {
  profile: string;
  memoryEnabled: boolean;
  userProfileEnabled: boolean;
  limits: Record<HermesMemoryTarget, number>;
  entries: Record<HermesMemoryTarget, string[]>;
  usedChars: Record<HermesMemoryTarget, number>;
  /** Message du magasin après une écriture (« Entry added. »), sinon `null`. */
  message: string | null;
};

/** Une écriture nommée sur ce magasin : les trois actions de l'outil `memory`. */
export type HermesProfileMemoryWrite =
  | { action: "add"; target: HermesMemoryTarget; content: string }
  | { action: "replace"; target: HermesMemoryTarget; oldText: string; content: string }
  | { action: "remove"; target: HermesMemoryTarget; oldText: string };

/** Résultat relu d'une bascule de serveur MCP dans un profil nommé. */
export type HermesProfileMcpServerState = {
  name: string;
  profile: string;
  enabled: boolean;
  requested: boolean;
  applied: boolean;
};

/**
 * Déconnexion d'un serveur MCP d'un profil nommé. `removed: false` : le profil
 * ne le portait pas (l'appel est idempotent). `tokensRemoved: false` : un
 * fichier de jeton a survécu dans le home du profil.
 */
export type HermesProfileMcpServerRemoval = {
  profile: string;
  name: string;
  removed: boolean;
  tokensRemoved: boolean;
};

/** Résultat relu d'une bascule de skill dans un profil nommé. */
export type HermesProfileSkillState = {
  name: string;
  profile: string;
  enabled: boolean;
  requested: boolean;
  applied: boolean;
};

/**
 * Résultat relu de l'extinction (ou du rétablissement) en bloc des skills
 * livrées avec Hermes dans un profil nommé. Les skills apprises et celles de
 * la Marketplace ne sont pas comptées.
 */
export type HermesProfileBundledSkillsState = {
  profile: string;
  requested: boolean;
  bundled: number;
  bundledEnabled: number;
  applied: boolean;
};

export const SKILLS_HUB_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;
export const SKILLS_HUB_PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const SKILLS_HUB_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type HermesSkillsHubTrustLevel = "official" | "trusted" | "builtin" | "community";
export type HermesSkillsHubSearchResult = {
  name: string;
  identifier: string;
  source: string;
  trustLevel: HermesSkillsHubTrustLevel;
  description: string;
};

export type HermesSkillsHubInspection = {
  name: string;
  description: string;
  source: string;
  identifier: string;
  tags: string[];
  skillMdPreview: string | null;
};

export type HermesSkillsHubFinding = {
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  description: string;
  file: string | null;
  line: number | null;
};

export type HermesSkillsHubScan = {
  trustLevel: HermesSkillsHubTrustLevel;
  source: string;
  verdict: "safe" | "caution" | "dangerous";
  policy: "allow" | "ask" | "block";
  findings: HermesSkillsHubFinding[];
};

export type HermesSkillsHubOperationState = "queued" | "running" | "succeeded" | "failed";
export type HermesSkillsHubOperationError = { code: string; detail: string };
export type HermesSkillsHubOperation = {
  operationId: string;
  profile: string;
  identifier: string;
  state: HermesSkillsHubOperationState;
  error: HermesSkillsHubOperationError | null;
  skills: string[] | null;
};

export type HermesProfileSkillsHubDelete = {
  profile: string;
  skill: string;
  skills: string[];
};

/**
 * Résultat relu de `POST /hermes-setup/profiles/{slug}/model`.
 *
 * `provider` et `model` sont ceux de l'inventaire (`profiles[].model`), jamais
 * ceux demandés. `applied` dit si les deux coïncident.
 */
export type HermesProfileModelState = {
  profile: string;
  provider: string;
  model: string;
  applied: boolean;
};

/** Le plus de profils qu'accepte `POST /hermes-setup/profiles/models` (borne hôte). */
export const PROFILE_MODEL_BATCH_MAX = 64;

/**
 * Une ligne relue de `POST /hermes-setup/profiles/models` : `applied` vient de
 * l'inventaire relu par l'hôte après l'écriture, `code` d'un refus de ce profil.
 */
export type HermesProfileModelBatchEntry = {
  profile: string;
  provider: string | null;
  model: string | null;
  applied: boolean;
  code: string | null;
};

export type HermesApprovalPolicyMode = "ask_writes" | "block_writes" | "off";
export type HermesApprovalPolicyState = {
  mode: HermesApprovalPolicyMode;
  pluginEnabled: boolean;
  effective: boolean;
  /**
   * PERM2-A: the profile's installed plugin names and describes its gates.
   * `false` from a host older than the gate identity.
   */
  gateIdentity: boolean;
  /** Tool keys the plugin blocks without a gate; `null`: the host cannot block. */
  blockedTools: string[] | null;
};

export type HermesHostProfileCreateOptions = {
  displayName?: string;
  provider?: string;
  model?: string;
};

/** Résultat relu d'un credential fournisseur propre à un profil nommé. */
export type HermesProfileCredentialResult = {
  provider: string;
  profile: string;
  verification: HermesProviderVerification;
  detail: string | null;
};

export type HermesMcpTransport = "http" | "stdio" | "unknown";
export type { HermesMcpAuth, HermesProfileNamedFlag } from "./host-profile-flags";

/**
 * Un serveur MCP configuré sur l'hôte. Aucun champ ne porte de secret :
 * `endpoint` est une localisation, une commande stdio est nommée sans son
 * argv, et l'environnement est rendu par CLÉ : la valeur d'un `env` MCP est
 * couramment un jeton.
 */
export type HermesMcpServer = {
  name: string;
  transport: HermesMcpTransport;
  endpoint: string | null;
  command: string | null;
  auth: HermesMcpAuth;
  configEnabled: boolean;
  platformEnabled: boolean;
  toolsIncluded: string[] | null;
  toolsExcluded: string[] | null;
  envKeys: string[];
  discoveredTools: string[] | null;
  unreachable: boolean;
  /**
   * Pour un serveur `oauth` : l'hôte détient-il un jeton sur le disque (jamais
   * son contenu). `null` pour les autres modes. Un serveur enregistré sans
   * jeton est inerte : le client amont refuse d'ouvrir une session, et le
   * gateway ne liste jamais ses outils.
   */
  oauthTokenPresent: boolean | null;
};

export type HermesMcpCatalogEnvSpec = {
  name: string;
  description: string | null;
  required: boolean;
  secret: boolean;
};

/** Une entrée du catalogue MCP approuvé présent sur l'hôte. */
export type HermesMcpCatalogEntry = {
  name: string;
  description: string | null;
  source: string | null;
  authType: string;
  authProvider: string | null;
  transport: "http" | "stdio";
  requiresInstall: boolean;
  envSpecs: HermesMcpCatalogEnvSpec[];
};

export type HermesMcpInventory = {
  platform: string;
  servers: HermesMcpServer[];
  catalog: HermesMcpCatalogEntry[];
};

export type HermesMcpOauthStatus = HermesProviderOauthStatus;

export type { HermesMcpOauthSession } from "./mcp-oauth-session";

export type HermesGatewayRestartStatus = "running" | "ok" | "failed";
export type HermesGatewayRestartStep = "restart" | "health" | "done";

/** Un redémarrage du gateway, suivi jusqu'à sa preuve sur `/health`. */
export type HermesGatewayRestartJob = {
  jobId: string;
  status: HermesGatewayRestartStatus;
  step: HermesGatewayRestartStep;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  expiresAt: string;
};

/**
 * The gateway state as the host reports it: is a restart pending (a change the
 * gateway reads at boot landed since it last started: an MCP write or OAuth
 * authorization, a per-profile MCP toggle, an A2A peer token write, or an
 * edge-setup upgrade that changed the gateway unit's directives while runs
 * were in progress), and the last job.
 */
export type HermesGatewayStatus = {
  restartPending: boolean;
  pendingSince: string | null;
  activeSince: string | null;
  job: HermesGatewayRestartJob | null;
};

/** Ce qu'openedbot envoie pour ajouter un serveur MCP HTTP à l'hôte. */
export type HermesMcpServerRequest = {
  name: string;
  url: string;
  auth: HermesMcpAuth;
  /** Jeton porteur, transmis dans le corps et jamais dans le chemin. */
  token?: string;
  replace?: boolean;
};

export const HERMES_BROWSER_CONTROL_PROTOCOL_VERSION = 1 as const;

export const HERMES_BROWSER_CONTROL_REQUIRED_CAPABILITIES = [
  "browser_back",
  "browser_click",
  "browser_navigate",
  "browser_press",
  "browser_screenshot",
  "browser_scroll",
  "browser_snapshot",
  "browser_tab_activate",
  "browser_tabs",
  "browser_type",
] as const;

export type HermesBrowserControlCapability =
  typeof HERMES_BROWSER_CONTROL_REQUIRED_CAPABILITIES[number];

export type HermesBrowserControlTransportProbe = {
  status: "not_reported" | "disabled" | "incompatible" | "transport_compatible";
  reason:
    | "FEATURE_NOT_ADVERTISED"
    | "FEATURE_DISABLED"
    | "PROTOCOL_INCOMPATIBLE"
    | "REAL_ACTIONS_NOT_ATTESTED"
    | "ENDPOINT_CONTRACT_INVALID"
    | "TRANSPORT_NOT_SUPPORTED"
    | "CAPABILITIES_INCOMPLETE"
    | null;
  protocolVersion: number | null;
  capabilities: HermesBrowserControlCapability[];
  controllerBindingProven: false;
};

/** Evenement brut du runtime. Le type est DANS le JSON ; un gateway direct n'emet ni `event:` ni `id:` SSE. */
export type HermesEvent = {
  event: string;
  run_id: string;
  /** Epoch FLOTTANT en secondes, pas ISO. */
  timestamp: number;
  /**
   * Numero de sequence du journal du connecteur, lu dans le champ SSE `id:`
   * quand la trame en porte un. Absent sur un gateway direct.
   */
  sequence?: number;
  [k: string]: unknown;
};

// ---- Client protocol constants: body bounds, per-route timeouts, name grammars ----

/**
 * La page de transcript demandée au gateway. Exportée parce que l'appelant en
 * a besoin pour savoir si la session DÉBORDE de ce qu'il a lu : une page pleine
 * ne se lit pas comme une session entière. Le gateway plafonne à 500.
 */
export const SESSION_MESSAGES_PAGE_LIMIT = 128;
export const MAX_ERROR_BODY_BYTES = 64 * 1024;
export const MAX_INVENTORY_BODY_BYTES = 1024 * 1024;
export const MAX_SESSION_MESSAGES_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_PROVIDER_BODY_BYTES = 64 * 1024;
export const PROVIDER_MUTATION_TIMEOUT_MS = 45_000;
export const PROVIDER_POLL_TIMEOUT_MS = 10_000;
export const HOST_CAPABILITIES_TIMEOUT_MS = 5_000;
/** `hermes tools` réécrit tout le fichier de config sous un Python froid. */
export const TOOLSET_MUTATION_TIMEOUT_MS = 100_000;
export const MCP_READ_TIMEOUT_MS = 35_000;
export const PROFILE_INVENTORY_TIMEOUT_MS = 60_000;
export const PROFILE_AVATAR_TIMEOUT_MS = 20_000;
export const PROFILE_MUTATION_TIMEOUT_MS = 120_000;
export const SKILLS_HUB_READ_TIMEOUT_MS = 35_000;
export const SKILLS_HUB_SCAN_TIMEOUT_MS = 120_000;
export const SKILLS_HUB_INSTALL_TIMEOUT_MS = 190_000;
export const SKILLS_HUB_POLL_TIMEOUT_MS = 15_000;
export const PROFILE_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const TOOLSET_KEY_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const PROVIDER_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Un ajout MCP sonde le serveur distant avant d'enregistrer quoi que ce soit. */
export const MCP_MUTATION_TIMEOUT_MS = 120_000;
/** Une entrée de catalogue peut cloner un dépôt et lancer son bootstrap. */
export const MCP_INSTALL_TIMEOUT_MS = 190_000;
/**
 * L'ouverture d'une autorisation MCP attend l'URL du fournisseur : découverte
 * puis enregistrement dynamique du client, sur un interpréteur froid. L'hôte
 * borne cette attente à 60 s ; on lui laisse répondre.
 */
export const MCP_OAUTH_START_TIMEOUT_MS = 75_000;
