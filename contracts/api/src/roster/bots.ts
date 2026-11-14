import type { BotPermissionMode } from "../permissions/policy";
import type { BotFaceSpec } from "../shared/bot-face";

type BotIsolation = "profile";

export type BotAutonomyPolicyDto = {
  enabled: boolean;
  maxDepth: number;
  maxSteps: number;
  maxHandoffs: number;
  timeoutSeconds: number;
  tokenBudget: number;
};

export type BotPurgeResultDto = {
  id: string;
  hostCleanup: "queued" | "none";
};

/** The reply language imposed on the bot; `auto` follows the operator's. */
export const BOT_REPLY_LANGUAGES = ["auto", "en", "fr", "es", "de", "it", "pt", "ja", "tr"] as const;

export type BotReplyLanguage = (typeof BOT_REPLY_LANGUAGES)[number];

/** Read-aloud rate of the bot's replies. */
export const BOT_SPEECH_RATES = [0.75, 1, 1.25, 1.5] as const;

export type BotSpeechRate = (typeof BOT_SPEECH_RATES)[number];

export type BotDto = {
  id: string;
  threadId: string;
  name: string;
  slug: string;
  description: string | null;
  instructions: string;
  model: string | null;
  reasoningEffort: string | null;
  /**
   * The bot asks for its model's fast mode (0181): same model, faster output,
   * billed at a higher rate. Honoured only on a model the runtime's catalogue
   * marks `fast`, and only while the run is served by the chosen model.
   * Absent before 0181.
   */
  fastMode?: boolean;
  sectionId: string;
  position: number;
  pinned: boolean;
  /**
   * Rank in the pinned grid, shared by bots and rooms (0159).
   * `null`: pinned without a rank (sorted after, by activity). Absent before 0159.
   */
  pinPosition?: number | null;
  face: BotFaceSpec | null;
  /** Public speech-synthesis identifier; `null` falls back to the client's default voice. */
  voiceId: string | null;
  /** Agent editor (0099). Absent on older servers. */
  label?: string | null;
  replyLanguage?: BotReplyLanguage;
  notifyOnFinish?: boolean;
  speechRate?: BotSpeechRate;
  permissionMode?: BotPermissionMode;
  hermesProfile: string | null;
  /** openedbot created and owns the corresponding named host profile. */
  /** Absent on responses from older servers. */
  hermesProfileManaged?: boolean;
  profileImportStatus?: "configuring" | "needs_attention" | null;
  profileProvisionStatus?: "preparing" | "failed" | null;
  /** The step in progress while `profileProvisionStatus` is `preparing` (0164), `null` before the first. */
  profileProvisionProgress?: BotProfileProvisionProgress | null;
  hostCleanupStatus?: "pending" | "verifying" | "failed" | null;
  /**
   * PERM2-2: whether the host plugin is proven to enforce the bot's mode.
   * `pending`: written, not yet in force (gateway restart, older host);
   * `unproven`: the last write or re-read failed. `null`: no managed profile.
   * Absent on older servers.
   */
  hostPolicy?: "effective" | "pending" | "unproven" | null;
  isolation: BotIsolation;
  hasOwnRuntime: false;
  runtimeName: string | null;
  awaitingApproval: boolean;
  /** A run of this thread is active or resuming. Absent on older servers. */
  running?: boolean;
  /** Bot/runtime activity later than the current user's last read receipt. */
  unread?: boolean;
  /** Personal preference: the thread is removed from the current roster, without being archived or deleted. */
  hidden?: boolean;
  preview: string | null;
  lastActivityAt: string;
  archivedAt: string | null;
  /**
   * Trash: the operator deleted this bot, its runtime sessions are
   * not yet erased. Always accompanied by `archivedAt`. Absent on
   * older servers.
   */
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  /** Bounded policy applied to multi-bot workflows launched by this bot. */
  autonomy?: BotAutonomyPolicyDto;
  /**
   * Write of the host profile's `model` block, reread. Present when this
   * response tried `hostSetProfileModel` (creation, model PATCH, or
   * runtime selection for bots without their own model). A host failure does not
   * block the openedbot update: `applied: false`.
   */
  profileModel?: { applied: boolean };
  /**
   * Only on a `POST /api/bots` answered `200`: its `clientRequestId` was
   * already used with the same body, this is the bot the first attempt
   * created (0135). The same id with another body is a 409
   * `BOT_CREATION_REQUEST_REUSED` (0136).
   */
  creationReplayed?: true;
};

/**
 * Where preparation of a new bot's profile stands: its space on the
 * server, its approval rules, then its tools (`tools`: the Hermes toolsets
 * it enables, known at the start of the step).
 */
export type BotProfileProvisionProgress = {
  step: "space" | "rules" | "tools";
  tools?: string[];
};
