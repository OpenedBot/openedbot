import type { PermissionContextDto } from "../permissions/policy";
import type { RuntimePublicDto } from "./runtime";
import type { RuntimeHealthStatus } from "../shared/domain";

/**
 * @deprecated The organization mode « intégré / externe » is removed. The server
 * always returns `"external"`; the screen reads `RuntimePublicDto.reachability`.
 */
export type RuntimeMode = "external";

/**
 * How a bot receives its model.
 *
 * - `per_bot`: the bot's model wins, the global choice serves only bots that
 *   do not have one. This is the historical behavior, and the default.
 * - `global`: every bot follows the global choice. An own model already
 *   set is not erased, only put to sleep: going back to `per_bot` restores
 *   it.
 */
export type ModelAssignmentMode = "global" | "per_bot";

export type ModelAssignmentModeInput = { mode: ModelAssignmentMode };

export type RuntimeAdminMode = "disabled" | "local";

// ─── Direct access to the client's workload (Cloudflare Tunnel, Tailscale Funnel) ───

/**
 * Cloudflare Access service token of a direct runtime. Sent by openedbot in
 * `CF-Access-Client-Id` / `CF-Access-Client-Secret`; encrypted at rest, never returned
 * to the browser (only `edgeAuthConfigured` is).
 */
export type RuntimeEdgeAuthInput = { clientId: string; clientSecret: string };

/** Body of `POST /api/runtime` to declare a `direct` runtime (row created inactive). */
export type RuntimeDirectAccessInput = {
  name: string;
  /** HTTPS required; `*.trycloudflare.com` refused. */
  url: string;
  /** `API_SERVER_KEY` du gateway Hermes. */
  token: string;
  edgeAuth?: RuntimeEdgeAuthInput | null;
};

/** Body of `PUT /api/runtimes/:id/access`: only the fields present change; `edgeAuth: null` removes the service token. */
export type RuntimeDirectAccessUpdateInput = {
  url?: string;
  token?: string;
  edgeAuth?: RuntimeEdgeAuthInput | null;
};

/** Diagnostics of the « Tester » probe of a direct runtime. A named code requires a specific proof. */
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

/** The three proofs, in order: reachable edge, valid authentication, toolsets contract. */
export type RuntimeProbeStep = "edge" | "auth" | "toolsets";

type RuntimeProbeStepResult = {
  step: RuntimeProbeStep;
  /** `null`: not run because a previous proof failed. */
  ok: boolean | null;
  code?: RuntimeProbeDiagnosticCode;
  /** Bounded detail with no secret (e.g. name of the forbidden toolset). */
  detail?: string | null;
};

/** Bounded hints kept for the diagnostic; never a response body. */
type RuntimeProbeHints = {
  status: number | null;
  contentType: string | null;
  /** `server: cloudflare` or a `cf-*` header observed. */
  cloudflare: boolean;
  /** Redirect to `*.cloudflareaccess.com` observed. */
  accessRedirect: boolean;
};

/** Response of `POST /api/runtime/test-draft` and `POST /api/runtimes/:id/test` for a direct runtime: 200 even on failure. */
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
   * The model assignment mode, at the organization. Absent from an older
   * server: the client must then read `per_bot`, the previous behavior.
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
   * openedbot can publish a gateway on its own Cloudflare account
   * (`OPENEDBOT_MANAGED_TUNNEL_URL` set). Absent on older servers.
   */
  managedTunnelAvailable?: boolean;
  /**
   * Assisted Tailscale Funnel publishing is open
   * (`OPENEDBOT_TAILSCALE_FUNNEL_ENABLED`). False or absent, the card stays
   * shown but disabled.
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
