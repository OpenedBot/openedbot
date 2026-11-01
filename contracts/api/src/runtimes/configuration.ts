import type { PermissionContextDto } from "../permissions/policy";
import type { RuntimePublicDto } from "./runtime";
import type { RuntimeHealthStatus } from "../shared/domain";

/**
 * @deprecated OHB-74 : le mode d'organisation « intégré / externe » est retiré. Le serveur
 * renvoie toujours `"external"` ; l'écran se lit sur `RuntimePublicDto.reachability`.
 */
export type RuntimeMode = "external";

/**
 * Comment un bot reçoit son modèle.
 *
 * - `per_bot` : le modèle du bot prime, le choix global ne sert qu'aux bots qui
 *   n'en ont pas. C'est le comportement historique, et le défaut.
 * - `global` : tous les bots suivent le choix global. Un modèle propre déjà
 *   posé n'est pas effacé, seulement mis en sommeil : revenir à `per_bot` le
 *   restitue.
 */
export type ModelAssignmentMode = "global" | "per_bot";

export type ModelAssignmentModeInput = { mode: ModelAssignmentMode };

export type RuntimeAdminMode = "disabled" | "local";

// ─── OHB-74 : accès direct à la charge du client (Cloudflare Tunnel, Tailscale Funnel) ───

/**
 * Service token Cloudflare Access d'un runtime direct. Envoyé par openedbot dans
 * `CF-Access-Client-Id` / `CF-Access-Client-Secret` ; chiffré au repos, jamais renvoyé
 * au navigateur (seul `edgeAuthConfigured` l'est).
 */
export type RuntimeEdgeAuthInput = { clientId: string; clientSecret: string };

/** Corps de `POST /api/runtime` pour déclarer un runtime `direct` (ligne créée inactive). */
export type RuntimeDirectAccessInput = {
  name: string;
  /** HTTPS obligatoire ; `*.trycloudflare.com` refusé. */
  url: string;
  /** `API_SERVER_KEY` du gateway Hermes. */
  token: string;
  edgeAuth?: RuntimeEdgeAuthInput | null;
};

/** Corps de `PUT /api/runtimes/:id/access` : seuls les champs présents changent ; `edgeAuth: null` retire le service token. */
export type RuntimeDirectAccessUpdateInput = {
  url?: string;
  token?: string;
  edgeAuth?: RuntimeEdgeAuthInput | null;
};

/** Diagnostics de la sonde « Tester » d'un runtime direct (US OHB-74 §4). Un code nommé exige une preuve spécifique. */
export type RuntimeProbeDiagnosticCode =
  | "RUNTIME_QUICK_TUNNEL_REFUSED"
  | "RUNTIME_DNS_UNRESOLVED"
  | "RUNTIME_TUNNEL_DOWN"
  | "RUNTIME_EDGE_AUTH_REQUIRED"
  | "RUNTIME_EDGE_AUTH_REJECTED"
  | "RUNTIME_BEARER_REJECTED"
  | "RUNTIME_NOT_HERMES"
  | "RUNTIME_CAPABILITIES_MISSING"
  | "RUNTIME_TOOLSET_FORBIDDEN"
  | "RUNTIME_PROBE_INDETERMINATE";

/** Les trois preuves, dans l'ordre : bord joignable, authentification valide, contrat toolsets. */
export type RuntimeProbeStep = "edge" | "auth" | "toolsets";

type RuntimeProbeStepResult = {
  step: RuntimeProbeStep;
  /** `null` : non jouée parce qu'une preuve précédente a échoué. */
  ok: boolean | null;
  code?: RuntimeProbeDiagnosticCode;
  /** Détail borné et sans secret (ex. nom du toolset interdit). */
  detail?: string | null;
};

/** Indices bornés conservés pour le diagnostic ; jamais un corps de réponse. */
type RuntimeProbeHints = {
  status: number | null;
  contentType: string | null;
  /** `server: cloudflare` ou en-tête `cf-*` observé. */
  cloudflare: boolean;
  /** Redirection vers `*.cloudflareaccess.com` observée. */
  accessRedirect: boolean;
};

/** Réponse de `POST /api/runtime/test-draft` et `POST /api/runtimes/:id/test` pour un runtime direct : 200 même en échec. */
export type RuntimeDirectProbeDto = {
  ok: boolean;
  steps: RuntimeProbeStepResult[];
  capabilities: Record<string, unknown> | null;
  hints: RuntimeProbeHints | null;
};

type RuntimeDevDefaultsDto = {
  name: string;
  url: string;
  hermesProfile: string | null;
};

export type RuntimeConfigurationDto = {
  runtime: RuntimePublicDto | null;
  runtimeMode: RuntimeMode;
  /**
   * Le mode d'attribution des modèles, à l'organisation. Absent d'un serveur
   * antérieur : le client doit alors lire `per_bot`, le comportement d'avant.
   */
  modelAssignmentMode?: ModelAssignmentMode;
  /**
   * D-1 (PERM2-7): the mode a new bot starts in when none is chosen. `auto`
   * once the organization is on the v2 pipeline and its runtime's review
   * profile is proven; `manual` otherwise. Absent on older servers: `manual`.
   */
  defaultPermissionMode?: "auto" | "manual";
  /**
   * PERM2-3: pipeline, ceiling, enforced review and review proof, to show a
   * bot's effective mode. Absent on older servers: the stored mode is shown.
   */
  permissionContext?: PermissionContextDto;
  adminMode: RuntimeAdminMode;
  /** Always null. Kept on the wire so older clients do not break. */
  devDefaults: RuntimeDevDefaultsDto | null;
  /**
   * OHB-75 : openedbot peut publier un gateway sur son propre compte Cloudflare
   * (`OHB_CF_*` renseignés). Absent sur les serveurs antérieurs.
   */
  managedTunnelAvailable?: boolean;
  /**
   * OHB-75 : la publication Tailscale Funnel assistée est ouverte
   * (`OHB_TAILSCALE_FUNNEL_ENABLED`). Fausse ou absente, la carte reste
   * affichée mais désactivée.
   */
  tailscaleFunnelAvailable?: boolean;
};

export type RuntimeTestDto = {
  ok: boolean;
  status: RuntimeHealthStatus;
  detectedVersion?: string | null;
  capabilities: Record<string, unknown> | null;
  error?: string | null;
  latencyMs?: number;
};
