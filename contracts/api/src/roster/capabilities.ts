import type { BotDto } from "./bots";

/**
 * What a bot can actually call: and what it has actually called.
 *
 * The two halves do NOT have the same scope and the screen must say so:
 * `scope: "profile"` means that reread `toolsets`/`skills` and MCP servers
 * concern this bot's named profile; `scope: "runtime"` keeps
 * the shared inventory of the legacy runtime. `usage` is always specific to
 * this bot. Presenting them without their scope would be false.
 */
export type BotCapabilitiesDto = {
  botId: string;
  /** `null` = this bot talks at the runtime root (optional Hermes profile). */
  hermesProfile: string | null;
  /** `profile` only when the host exposes per-profile capabilities. */
  scope: "profile" | "runtime";
  /** The current operator may relay profile capability writes. */
  writable: boolean;
  /** The host can create a named profile for this bot. */
  profileManagement: boolean;
  runtimeName: string | null;
  /** `null` = this build does not expose the endpoint. Never « none ». */
  toolsets: BotToolsetDto[] | null;
  skills: BotSkillDto[] | null;
  /** Profile-scoped MCP flags and safe inventory details, or `null` outside that scope. */
  mcpServers: BotMcpServerDto[] | null;
  usage: BotToolUsageDto[];
  /**
   * Window of `usage`, in days. `run_events` is an SSE delivery buffer
   * purged beyond that (0012): past this window, « never called » and
   * « called then forgotten » can no longer be told apart.
   */
  usageWindowDays: number;
  /**
   * Why the inventory is missing, when it is missing. Distinguishes the two `null`
   * values `toolsets` can carry: endpoint absent from this build (`null` here
   * too) and a runtime that could not be read (filled in). Without this field, a
   * Hermes that is off would read as « this build has no skills ».
   *
   * Usage, for its part, comes from our database: it stays served even with the runtime off:
   * what a dry 502 would have taken with it.
   */
  inventoryError: { code: string; message: string } | null;
};

export type BotToolsetDto = {
  name: string;
  label: string;
  description: string | null;
  /** The model can call it. */
  enabled: boolean;
  /** It will succeed. `enabled && !configured` = a failure waiting for its moment. */
  configured: boolean;
  tools: string[];
  /**
   * The toolset's tools are callable on the host, according to the Hermes
   * registry (`check_fn`), not according to `/v1/toolsets`. `null`: the host does not
   * say so (older edge-setup, failed read, toolset not measured).
   */
  available: boolean | null;
  /** Closed code, only when `available` is `false` and the host provides it. */
  unavailableReason: "credentials_missing" | "check_failed" | null;
};

export type BotSkillDto = {
  name: string;
  description: string | null;
  category: string | null;
  /** Reread on the profile (`disabled_skills`); `true` outside profile scope. */
  enabled: boolean;
  /** The current operator may toggle this skill on the bot's profile. */
  writable: boolean;
};

export type BotProfileCredentialDto = {
  provider: string;
  profile: string;
  verification: "confirmed" | "denied" | "unverified";
  detail: string | null;
};

export type BotMcpServerDto = {
  name: string;
  enabled: boolean;
  transport: "http" | "stdio" | "unknown" | null;
  tools: string[] | null;
  unreachable: boolean | null;
  /**
   * What the host says of this entry in the bot's profile, together, or none
   * of them (older edge-setup: unknown). `oauthTokenPresent` is the PROFILE's
   * own token file, `null` when unchecked or for another auth mode.
   */
  endpoint?: string | null;
  auth?: "none" | "header" | "oauth";
  oauthTokenPresent?: boolean | null;
};

/** What openedbot keeps in the database and recreates on a new profile. */
export type BotProfileCarried = "identity" | "model" | "persona" | "conversations";

/** What lived only in the old host's profile. */
export type BotProfileLost = "memory" | "credentials" | "capabilities" | "sessions";

/** `missing`: the bot names a profile the current runtime does not have (runtime replaced). */
type BotProfileState = "present" | "missing" | "none" | "unknown";

export type BotProfileStatusDto = {
  profile: string | null;
  state: BotProfileState;
  /** The host knows how to create a profile: transfer and reset are possible. */
  canRepair: boolean;
  /**
   * Neither the bot (for a transfer) nor the runtime names a model: the repair
   * needs one chosen by the operator (`BotProfileRepairInput`), otherwise it is
   * refused with `RUNTIME_MODEL_REQUIRED` instead of creating a profile that no
   * run could use. Absent from an API older than the field: read it as false.
   */
  needsModel?: { transfer: boolean; reset: boolean };
  carried: BotProfileCarried[];
  lost: BotProfileLost[];
};

/** Body of `POST /api/bots/:botId/profile/{transfer,reset}`; the model is kept on the bot. */
export type BotProfileRepairInput = {
  model?: string;
  provider?: string;
};

export type BotProfileRepairDto = {
  bot: BotDto;
  mode: "transfer" | "reset";
  profile: string;
  /** Model set on the recreated profile; `null` when the runtime imposes none. */
  model: string | null;
  carried: BotProfileCarried[];
  lost: BotProfileLost[];
};

export type BotCapabilityMutationDto = {
  name: string;
  profile: string;
  platform?: string;
  enabled: boolean;
  requested: boolean;
  applied: boolean;
};

export type BotToolUsageDto = {
  tool: string;
  calls: number;
  failures: number;
  lastUsedAt: string;
};
