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
};

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
  createdByKind: "member" | "agency";
  createdByName: string | null;
  createdFromApprovalId: string | null;
  createdFromThreadId: string | null;
};

/** PERM2-4, D-3: the runtime switch for dangerous commands, valid for every bot of the runtime. */
export type RuntimePermissionSettingsDto = {
  runtimeId: string;
  terminalDangerAlways: boolean;
  updatedAt: string | null;
  updatedByKind: "member" | "agency" | null;
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
