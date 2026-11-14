import type { BotPermissionMode } from "../permissions/policy";
import type { BotAutonomyPolicyDto, BotReplyLanguage, BotSpeechRate } from "./bots";
import type { BotFaceSpec } from "../shared/bot-face";

/** What the client may change on a bot: the slug and the Hermes profile are immutable. */
export type UpdateBotInput = Partial<{
  name: string;
  description: string | null;
  instructions: string;
  model: string | null;
  provider: string | null;
  reasoningEffort: string | null;
  /** The model's fast mode (0181): honoured only on a model the catalogue marks `fast`. */
  fastMode: boolean;
  pinned: boolean;
  face: BotFaceSpec | null;
  voiceId: string | null;
  archived: boolean;
  autonomy: Partial<BotAutonomyPolicyDto>;
  sectionId: string;
  label: string | null;
  replyLanguage: BotReplyLanguage;
  notifyOnFinish: boolean;
  speechRate: BotSpeechRate;
  permissionMode: BotPermissionMode;
}>;

/**
 * Background alignment of the host profiles of bots put back on the global
 * model (`GET /api/bots/model-overrides/sync`). `done` counts the profiles
 * handled, aligned or failed: the progress bar reads it as is.
 * A failed profile is not lost: the worker rereads the profile's `model` block
 * on every run and rewrites it if it differs.
 */
export type BotProfileModelSyncDto = {
  id: string;
  status: "running" | "done";
  total: number;
  done: number;
  aligned: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
};

/**
 * Response of `POST /api/bots/model-overrides/reset`: `cleared` bots have lost
 * their own model and effort, in the database, before the response. `sync` is
 * the host alignment that follows, `null` when there is nothing to write on the host.
 */
export type BotModelResetDto = {
  cleared: number;
  sync: BotProfileModelSyncDto | null;
};

/**
 * Draft produced by `POST /api/bots/:botId/persona-drafts`.
 * An existing bot is required: there is no draft at creation.
 */
export type PersonaDraftDto = {
  status: "queued" | "starting" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "missing";
  runId: string | null;
  draft: string | null;
  hash: string | null;
};

/**
 * `routine_manage` for ONE bot (DEV-209): the MCP tool by which the bot manages
 * its own routines from the conversation. On by default (0187): openedbot
 * installs it on every bot whose host can carry it; the operator may switch
 * it off, and that choice is remembered.
 *
 *   - `enabled`: the operator's choice, `true` unless they switched it off;
 *   - `status`: what the bot's next run gets. `active`: the bot can schedule;
 *     `pending`: being installed, waiting for the host, or for the gateway to
 *     load it (about a minute); `restart_pending`: installed, the gateway sees
 *     it only after a restart the operator triggers; `switched_off`;
 *     `unavailable`: the host or the API cannot carry it (`reason`);
 *   - `reason`: why the status is not `active`, when a cause is known;
 *   - `available`: no lasting reason stands in the way.
 */
export type BotRoutineToolStatus = "active" | "pending" | "restart_pending" | "switched_off" | "unavailable";
export type BotRoutineToolReason =
  | "https_required"
  | "runtime_required"
  | "host_unsupported"
  | "profile_unsupported"
  | "host_offline"
  | "host_unreachable"
  | "unverified"
  /** The bot's profile is being created (or created again) on the host. */
  | "profile_preparing"
  /** The bot's profile could not be created: « Relancer » on the bot first. */
  | "profile_failed";

export type BotRoutineToolDto = {
  available: boolean;
  status: BotRoutineToolStatus;
  /** Why it waits or cannot work; with `active`, only `host_offline` (installed, host away). */
  reason: BotRoutineToolReason | null;
  enabled: boolean;
  restartPending: boolean;
};

/**
 * `bot_settings_propose` for ONE bot: the MCP tool by which the bot PROPOSES
 * changing its persona and its light settings (0099). Opt-in, switched on by
 * the operator. Nothing is applied without the operator (upstream parity:
 * a write of SOUL.md always requires a human, even with `--yolo`).
 */
export type BotSettingsToolDto = {
  available: boolean;
  reason: "https_required" | "runtime_required" | "host_unsupported" | "profile_unsupported" | null;
  enabled: boolean;
  restartPending: boolean;
};

/** Fields a bot may propose to change. Absent = unchanged. */
export type BotSettingProposalFields = {
  instructions?: string;
  label?: string | null;
  replyLanguage?: BotReplyLanguage;
  notifyOnFinish?: boolean;
};

export type BotSettingProposalStatus = "pending" | "applied" | "rejected" | "superseded" | "stale";

/**
 * A proposal from the bot, rendered as a card in the thread. `current` is the value
 * of the same fields at proposal time; `hash` binds the bytes the
 * operator saw to those they apply.
 */
export type BotSettingProposalDto = {
  id: string;
  botId: string;
  runId: string;
  threadId: string;
  status: BotSettingProposalStatus;
  reason: string | null;
  current: BotSettingProposalFields;
  proposed: BotSettingProposalFields;
  hash: string;
  createdAt: string;
  resolvedAt: string | null;
};

export type BotSettingProposalDecisionInput = { decision: "apply" | "reject"; expectedHash: string };
