import type { BotSkillDto } from "../roster/capabilities";
import type { RuntimeProviderOauthStatus } from "./providers";

/**
 * Read-only inventory of the tools Hermes actually declares.
 *
 * `configured` repeats the `/v1/toolsets` signal word for word: it does not
 * by itself PROVE that an OAuth account is connected. Depending on the toolset, the
 * missing configuration may be a key, a binary, an endpoint or another
 * dependency. Keeping this name avoids turning that signal into a false
 * authentication state in the clients.
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
   * `true` when the host accepts writing this toolset on its
   * `api_server` platform. Distinct from `enabled`: a toolset restricted to another
   * platform is read in the inventory but the upstream write would drop it
   * silently: the screen must therefore show its state without a switch.
   *
   * `false` also when the runtime offers no write channel: in that case
   * `management.writable` is `false` and the page stays read-only.
   */
  settable: boolean;
  /**
   * `true` when the openedbot contract refuses this toolset (`FORBIDDEN_TOOLSETS`).
   * It never turns on, neither here nor on the host; it does not turn off.
   */
  forbidden: boolean;
};

/** The result of a toggle, REREAD by the host on `/v1/toolsets`. */
export type RuntimeIntegrationToolsetStateDto = {
  name: string;
  enabled: boolean;
  requested: boolean;
  /** `false` = the host wrote, and the inventory still says the opposite. */
  applied: boolean;
};

export type RuntimeIntegrationMcpServerDto = {
  name: string;
  transport: "http" | "stdio" | "unknown";
  /** A location, never a credential. */
  endpoint: string | null;
  command: string | null;
  auth: "none" | "header" | "oauth";
  /** Enabled in the runtime configuration. */
  configEnabled: boolean;
  /** Carried by the platform the openedbot runs use. */
  platformEnabled: boolean;
  toolsIncluded: string[] | null;
  toolsExcluded: string[] | null;
  /** Names of the environment variables, never their values. */
  envKeys: string[];
  /** Tools seen at the add probe; `null` outside that pass. */
  discoveredTools: string[] | null;
  /** The host registered the server but could not reach it. */
  unreachable: boolean;
  /**
   * `oauth` server: does the host hold a token on disk (never its
   * contents). `null` for the other modes, and for an older host that
   * does not say. Without a token, the server is inert: no tool will
   * ever be listed, whatever the « porté par la plateforme » badge.
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
 * The host's MCP servers and the approved catalog it carries, returned by
 * `GET /api/runtime/integrations/mcp`.
 *
 * This read is SEPARATE from the inventory: it starts an interpreter on
 * the host, and only the connector administration panel needs it. Folding
 * it into the page would make every display of the screen pay that cost.
 *
 * `available` is `false` when the runtime does not offer `mcp_management`: the
 * page then says what it cannot do, rather than showing an empty list
 * one would read as « no connector ».
 */
export type RuntimeIntegrationMcpDto = {
  available: boolean;
  /**
   * What the host announces besides `mcp_management`: `oauth` (the four
   * authorization verbs of an `auth: oauth` server) and `gatewayRestart`
   * (the gateway state and the only restart the link carries). A host that
   * does not announce it gets no button.
   */
  capabilities: { oauth: boolean; gatewayRestart: boolean };
  servers: RuntimeIntegrationMcpServerDto[];
  catalog: RuntimeIntegrationMcpCatalogEntryDto[];
  error: { code: string; message: string } | null;
};

/**
 * An OAuth authorization of an MCP server, played on the host with this
 * browser as the only human leg: `authorizationUrl` opens in a
 * tab, the provider sends the browser back to the API, which relays the
 * callback to the host. `connected` only when the host has reread a token on its
 * disk and listed the tools with it.
 */
/** Removal of a catalog entry from a bot (profile configuration and tokens). */
export type RuntimeMcpDisconnectDto = {
  connector: string;
  botId: string;
  /** `false`: the profile no longer carried this server already. */
  removed: boolean;
  /** The host erased the profile's tokens for this server (or had none). */
  tokensRemoved: boolean;
};

export type RuntimeMcpOauthDto = {
  sessionId: string;
  server: string;
  status: RuntimeProviderOauthStatus;
  /**
   * The provider's callback reached the host, which is completing the
   * authorization and refuses to cancel it. `null`: an older host that does
   * not say, and always accepts a cancel; the screen then never cancels on
   * its own.
   */
  callbackReceived: boolean | null;
  authorizationUrl: string | null;
  error: string | null;
  errorCode: string | null;
  discoveredTools: string[];
  expiresAt: string;
};

export type RuntimeGatewayRestartDto = {
  jobId: string;
  status: "running" | "ok" | "failed";
  /** `restart`: the unit restarts; `health`: waiting for `/health`; `done`. */
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
  /** `null` = inventory endpoint absent or read impossible, never « no tool ». */
  toolsets: RuntimeIntegrationToolsetDto[] | null;
  /** `null` = this Hermes build does not expose `/v1/skills`, or its read failed (`skillsError`). */
  skills: BotSkillDto[] | null;
  /** `/v1/skills` exists but failed on the runtime side; the toolsets stay readable. */
  skillsError: { code: string; message: string } | null;
  support: "available" | "partial" | "unavailable";
  totals: {
    /** `null` = toolsets inventory absent; zero = inventory present and no result. */
    ready: number | null;
    configurationRequired: number | null;
    disabled: number | null;
    tools: number | null;
    /** `null` = skills endpoint absent; zero = endpoint present and empty list. */
    skills: number | null;
  };
  /** Closed public diagnostic: never an upstream body, URL, token or internal identifier. */
  inventoryError: { code: string; message: string } | null;
  management: {
    /**
     * `true` when the host announces `toolset_management` / `mcp_management`:
     * openedbot then writes through the edge-setup operator, on the HTTPS channel already
     * authenticated, without ever opening a shell session to the machine.
     *
     * `false` stays the honest case from before: the gateway does not publish the
     * MCP administration routes, and nothing is written from here.
     */
    writable: boolean;
    /** What the host can do, as it announced it. */
    capabilities: { toolsets: boolean; mcp: boolean };
    owner: "hermes";
    canConfigure: boolean;
    settingsPath: "/settings/runtime";
    /** Result of the gateway's GET probe; it no longer decides the write. */
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
