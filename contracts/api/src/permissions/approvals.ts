import type { DecisionTraceDto } from "./policy";

export type ApprovalRequestDto = {
  id: string;
  runId: string;
  threadId: string;
  botId?: string | null;
  kind: string;
  action: string;
  detail: string | null;
  choices: string[];
  status: "pending" | "approved" | "allowed" | "denied" | "expired";
  requestedAt: string;
  respondedAt: string | null;
  /**
   * PERM2-7: set when the automatic review handed this gate to a human.
   * Absent from an older API, `null` when no review took part.
   */
  review?: ApprovalReviewDto | null;
  /**
   * PERM2-4: the "Always" this viewer may answer with, computed by the
   * server (and computed again on the click). Absent or `null`: none.
   */
  alwaysOffered?: ApprovalAlwaysChoice | null;
  /**
   * The proven tool key of a `plugin_tool` gate (`write_file`, `mcp:srv:tool`)
   * and its bounded, redacted descriptor arguments (`path`, `paths`, `ops`...),
   * so the console can phrase the request itself. `null` for a terminal or
   * unidentified gate, absent from an older API: `detail` is then the text.
   */
  toolKey?: string | null;
  gateArgs?: Record<string, unknown> | null;
  /**
   * What a `routine_manage` gate is about to do, read by the platform from the
   * call's validated arguments (never the run key). `null` for that tool when
   * the host sent no arguments (too long to describe); absent for any other
   * tool and from an older API.
   */
  routine?: RoutineGateDto | null;
};

/**
 * A schedule as the call states it. `delay`: counted from the moment the call
 * runs, after the approval; `once`: an instant, `local` when the bot wrote it
 * as a wall-clock time of `timezone`; `unreadable`: a text the tool refuses.
 */
export type RoutineGateScheduleDto =
  | { kind: "delay"; seconds: number }
  | { kind: "once"; at: string; local: boolean }
  | { kind: "recurring"; cron: string }
  | { kind: "unreadable"; text: string };

/**
 * Why the tool will refuse the call as stated (`routine-tool-routes.ts`):
 * lengths are the tool's own limits, a one-shot instant must be ahead.
 */
export type RoutineGateIssue =
  | "timezone_missing"
  | "timezone_invalid"
  | "too_frequent"
  | "past_instant"
  | "name_too_long"
  | "schedule_too_long"
  | "prompt_too_long";

/**
 * The message the routine sends the bot at each run: a sanitized excerpt,
 * `null` when the host did not transmit it (too long for its descriptor), and
 * its full length in Unicode code points.
 */
export type RoutineGatePromptDto = { excerpt: string | null; chars: number };

/**
 * Model or user text (`name`, `routine`, `prompt.excerpt`, an `unreadable`
 * schedule) is data: control and format characters removed, quote marks
 * neutralized, bounded. `routine` is the current name of the routine `job_id`
 * points to, `null` when it is none of the bot's. `unattended`: the routine
 * runs without asking for an approval (always for a creation by the bot;
 * `null` when the routine is unknown).
 */
export type RoutineGateDto =
  | { action: "list" }
  | {
      action: "create";
      name: string;
      schedule: RoutineGateScheduleDto;
      timezone: string | null;
      prompt: RoutineGatePromptDto;
      issue: RoutineGateIssue | null;
    }
  | {
      action: "update";
      routine: string | null;
      unattended: boolean | null;
      name: string | null;
      prompt: RoutineGatePromptDto | null;
      schedule: RoutineGateScheduleDto | null;
      timezone: string | null;
      issue: RoutineGateIssue | null;
    }
  | { action: "pause"; routine: string | null }
  | { action: "resume"; routine: string | null; unattended: boolean | null }
  | { action: "remove"; routine: string | null };

/** `always_bot_tool`: this tool on this bot; `always_runtime_terminal`: dangerous commands on the runtime (every bot). */
export type ApprovalAlwaysChoice = "always_bot_tool" | "always_runtime_terminal";

/** Hermes always receives `once` for an "Always": the pre-approval lives in openedbot. */
export type ApprovalDecisionInput = { choice: "once" | "deny" | ApprovalAlwaysChoice; reason?: string };

export type ApprovalRespondDto = {
  decision: { id: string; entryHash: string };
  /** Present for an "Always" answer. `saved: false`: the gate was still allowed once. */
  always?: { choice: ApprovalAlwaysChoice; saved: boolean; error?: string };
};

/** PERM2-4: an active "Always for this tool on this bot". */
export type BotPermissionGrantDto = {
  id: string;
  toolKey: string;
  createdAt: string;
  createdByKind: "member";
  createdByName: string | null;
  createdFromApprovalId: string | null;
  createdFromThreadId: string | null;
};

/** PERM2-4, D-3: the runtime switch for dangerous commands, valid for every bot of the runtime. */
export type RuntimePermissionSettingsDto = {
  runtimeId: string;
  terminalDangerAlways: boolean;
  updatedAt: string | null;
  updatedByKind: "member" | null;
  updatedByName: string | null;
};

/**
 * Why the automatic review left a gate to a human. `escalated` covers the
 * reviewer's own escalation and any other failure (invalid output, error);
 * `timeout` is the 15 s budget; `circuit_open` is three denials in a row;
 * `runtime_busy` is a gateway with no free run slot for the reviewer (the
 * bot's own run, waiting on this gate, holds the only one).
 */
export type ApprovalReviewReason = "review_escalated" | "review_timeout" | "review_circuit_open" | "review_runtime_busy";

export type ApprovalReviewDto = {
  reason: ApprovalReviewReason;
  /** The reviewer's own words, plain text, at most 300 characters. */
  note: string | null;
};

export type DecisionDto = {
  id: string;
  runId: string;
  botId: string;
  botName: string;
  action: string;
  kind: string;
  choice: "once" | "deny";
  origin: "human" | "policy";
  /** The mode that answered a policy decision; `manual` and `plan` only ever refuse. */
  policy: "auto" | "bypass" | "manual" | "plan" | null;
  approverUserId: string | null;
  approverRole: string;
  entryHash: string | null;
  issuedAt: string;
  /** PERM2-11: who or what decided, and why. Absent from an older API. */
  trace?: DecisionTraceDto | null;
};
