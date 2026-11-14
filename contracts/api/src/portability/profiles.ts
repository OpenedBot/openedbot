/** Volatile inventory of Hermes profiles already present on the host. Never persisted. */
export type RuntimeHostProfileDto = {
  name: string;
  displayName: string;
  title: string | null;
  description: string | null;
  model: { default: string | null; provider: string | null };
  hasAvatar: boolean;
  routineCount: number;
  routines: Array<{
    name: string;
    schedule: string;
    prompt: string;
    enabled: boolean;
    deliver: boolean;
    model: string | null;
  }>;
  pinned: boolean;
  hidden?: boolean;
  /**
   * The MCP servers the profile configuration carries. Carrying one is not a
   * connection: a profile is cloned from the root config, and the per-bot MCP
   * switch copies the root entry, both without a token. Empty for an older
   * snapshot.
   */
  mcpServers: RuntimeProfileMcpServerDto[];
  /**
   * The host described this profile's MCP entries: an empty `mcpServers`
   * then means « no server ». Absent from an older host or snapshot.
   */
  mcpFacts?: true;
  /** Includes archived bots: any row with hermes_profile. */
  alreadyImported: boolean;
  importedBotId: string | null;
};

/**
 * One MCP server of a host profile. `endpoint`, `auth` and `oauthTokenPresent`
 * come together from a host that describes the entry; without `auth` (older
 * edge-setup, older snapshot) the host said nothing: unknown, never absent.
 */
export type RuntimeProfileMcpServerDto = {
  name: string;
  enabled: boolean;
  endpoint?: string | null;
  auth?: "none" | "header" | "oauth";
  /** `oauth` only: the profile's own token file is on disk. `null`: not checked. */
  oauthTokenPresent?: boolean | null;
};

export type RuntimeProfileInventoryDto = {
  profiles: RuntimeHostProfileDto[];
  /** True when the host announced `profile_management` (disk delete is offered). */
  canDelete: boolean;
};

export type RuntimeProfileDeleteDto = {
  slug: string;
  hostDeleted: true;
  botId: string | null;
  purgedSessions: number;
  failedSessions: number;
};

type RuntimeProfileDeleteJobStatus = "queued" | "running" | "succeeded" | "failed";

export type RuntimeProfileDeleteJobItemDto = {
  slug: string;
  ok: boolean;
  error?: { code: string; message: string };
};

export type RuntimeProfileDeleteJobDto = {
  id: string;
  runtimeId: string;
  status: RuntimeProfileDeleteJobStatus;
  slugs: string[];
  completedProfiles: number;
  totalProfiles: number;
  currentSlug: string | null;
  results: RuntimeProfileDeleteJobItemDto[];
  createdAt: string;
  updatedAt: string;
  error: { code: string; message: string } | null;
};

export type RuntimeProfileDeleteJobListDto = { jobs: RuntimeProfileDeleteJobDto[] };

export type RuntimeProfileImportDto = {
  imported: Array<{
    slug: string;
    botId: string;
    threadId: string;
    name: string;
  }>;
  skipped: Array<{ slug: string; reason: RuntimeProfileImportSkipReason }>;
  groups: Array<{ name: string; groupId: string; memberSlugs: string[] }>;
  routines: Array<{ slug: string; routineId: string; name: string; schedule: string }>;
  limitations: string[];
};

type RuntimeProfileImportSkipReason = "hidden" | "not-in-inventory";

/** Bounded human-provided projection. Never raw YAML, credentials or skill contents. */
export type HermesProfileImportEntry = {
  name: string;
  displayName: string;
  title: string | null;
  description: string | null;
  soul: string | null;
  model: { default: string | null; provider: string | null };
  uiMeta: {
    title: string | null; color: string | null; shape: string | null;
    imageKind: string | null; hidden: boolean; pinned: boolean;
    sectionId: string | null; groups: string[]; created: string | null;
  } | null;
  hasAvatar: boolean;
  routines: Array<{
    name: string; schedule: string; prompt: string; enabled: boolean;
    deliver: boolean; model: string | null;
  }>;
  skills: HermesImportNamedFlag[];
  toolsets: HermesImportNamedFlag[];
  mcpServers: HermesImportNamedFlag[];
  avatar: { contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; base64: string } | null;
};

export type HermesImportNamedFlag = { name: string; enabled: boolean };

export type HermesBundleImportInput = {
  profiles: HermesProfileImportEntry[];
  sectionId?: string;
  idempotencyKey: string;
};

export type HermesBundleImportDto = RuntimeProfileImportDto & {
  capabilities: Array<{ slug: string; toolsets: HermesImportNamedFlag[]; mcpServers: HermesImportNamedFlag[]; skills: HermesImportNamedFlag[] }>;
};

type HermesBundleImportJobStatus = "queued" | "running" | "succeeded" | "failed" | "needs_attention";

export type HermesBundleImportJobDto = {
  id: string;
  runtimeId: string;
  status: HermesBundleImportJobStatus;
  phase: "prevalidation" | "creation" | "roster" | "capabilities" | "compensation" | "finished";
  completedProfiles: number;
  totalProfiles: number;
  createdAt: string;
  updatedAt: string;
  result: HermesBundleImportDto | null;
  error: { code: string; message: string; details?: { unconfirmedProfiles?: string[] } } | null;
};

export type HermesBundleImportJobListDto = { jobs: HermesBundleImportJobDto[]; nextCursor: string | null };
