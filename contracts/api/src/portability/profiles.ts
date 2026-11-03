/** Inventaire volatile des profils Hermes déjà présents sur l'hôte. Jamais persisté. */
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
   * Les serveurs MCP que porte la configuration du profil (nom et état).
   * Un serveur du catalogue n'y entre qu'une fois son jeton prouvé : c'est
   * la liste des connexions de ce bot. Vide pour un instantané plus ancien.
   */
  mcpServers: Array<{ name: string; enabled: boolean }>;
  /** Includes archived bots: any row with hermes_profile. */
  alreadyImported: boolean;
  importedBotId: string | null;
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
