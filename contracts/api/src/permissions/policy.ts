/**
 * PERM2-8 (DEV-OHB-259): the organization permission policy. Owners and
 * admins write it; every member reads it; agencies never reach it (D-5).
 * The same rules are checked by `permission_command_blocklist_valid`
 * (migration 0142): this module only produces the canonical form.
 */

export const PERMISSION_CEILINGS = ["manual", "auto", "bypass"] as const;

export type PermissionCeiling = (typeof PERMISSION_CEILINGS)[number];

export const PERMISSION_RULES_MODES = ["adds", "replaces"] as const;

export type PermissionRulesMode = (typeof PERMISSION_RULES_MODES)[number];

export const COMMAND_BLOCKLIST_MAX_ENTRIES = 50;

export const COMMAND_BLOCKLIST_MAX_LENGTH = 120;

export type OrganizationPermissionPolicyDto = {
  /** `null`: no ceiling. */
  maxMode: PermissionCeiling | null;
  enforceReview: boolean;
  /** How the organization's rules combine with a bot's own (PERM2-6). */
  rulesMode: PermissionRulesMode;
  commandBlocklist: string[];
  /** `0` while nothing was ever saved. */
  version: number;
  updatedAt: string | null;
};

export type OrganizationPermissionPolicyView = {
  policy: OrganizationPermissionPolicyDto;
  /** Owner or admin of the organization. */
  canEdit: boolean;
  /** The policy is enforced only by the `v2` permission pipeline. */
  enforced: boolean;
};

export type OrganizationPermissionPolicyInput = {
  maxMode: PermissionCeiling | null;
  enforceReview: boolean;
  rulesMode: PermissionRulesMode;
  commandBlocklist: string[];
  expectedVersion: number;
};

const MODE_RANK: Record<PermissionCeiling, number> = { manual: 0, auto: 1, bypass: 2 };

function rank(mode: string | null | undefined): number {
  return mode === "auto" || mode === "bypass" ? MODE_RANK[mode] : 0;
}

/**
 * Whether writing `next` over `previous` (absent on a creation) is refused
 * by the ceiling. Only a raise above the ceiling is: `plan` is always
 * permitted, lowering a mode is always allowed, and a bot already above the
 * ceiling stays stored as it is (the pipeline caps its effective mode).
 */
export function permissionModeRaiseRefused(
  next: BotPermissionMode,
  previous: BotPermissionMode | string | null | undefined,
  ceiling: PermissionCeiling | null,
): boolean {
  if (ceiling === null || next === "plan") return false;
  return rank(next) > MODE_RANK[ceiling] && rank(next) > rank(previous);
}

/** The highest mode a ceiling lets a new bot take: `mode` itself when allowed. */
export function permissionModeUnderCeiling(mode: BotPermissionMode, ceiling: PermissionCeiling | null): BotPermissionMode {
  return permissionModeRaiseRefused(mode, null, ceiling) ? ceiling! : mode;
}

/**
 * PERM2-3: what the console needs to tell a bot's EFFECTIVE mode from its
 * stored one, read from `GET /api/runtime` (`permissionContext`). The same
 * three steps as `effectivePermissionMode` in the execution domain (a test
 * keeps both in line); only the `v2` pipeline applies them.
 */
export type PermissionContextDto = {
  pipeline: "legacy" | "v2";
  maxMode: PermissionCeiling | null;
  enforceReview: boolean;
  /** The runtime's review profile is proven tool-less (PERM2-7a). */
  reviewProven: boolean;
};

export type EffectivePermissionReason = "ceiling" | "enforce_review" | "review_unproven";

export type EffectivePermission = { mode: BotPermissionMode; reason: EffectivePermissionReason | null };

/** The mode a bot really runs in, and why it differs from its stored one (`null`: it does not). */
export function effectiveBotPermission(stored: BotPermissionMode | null | undefined, context: PermissionContextDto | null | undefined): EffectivePermission {
  const mode: BotPermissionMode = stored === "plan" || stored === "auto" || stored === "bypass" ? stored : "manual";
  if (!context || context.pipeline !== "v2" || mode === "plan") return { mode, reason: null };
  let effective: PermissionCeiling = mode;
  let reason: EffectivePermissionReason | null = null;
  if (context.maxMode !== null && MODE_RANK[context.maxMode] < MODE_RANK[effective]) {
    effective = context.maxMode;
    reason = "ceiling";
  }
  if (effective === "bypass" && context.enforceReview) {
    effective = "auto";
    reason = "enforce_review";
  }
  if (effective === "auto" && !context.reviewProven) {
    effective = "manual";
    reason = "review_unproven";
  }
  return effective === mode ? { mode, reason: null } : { mode: effective, reason };
}

export type CommandBlocklistIssue = "too_many" | "not_text" | "empty" | "too_long" | "characters" | "command_name";

export type CommandBlocklistResult =
  | { ok: true; entries: string[] }
  | { ok: false; issue: CommandBlocklistIssue; index: number | null };

const FIRST_WORD = /^[A-Za-z0-9._+-]+$/;

const OTHER_WORD = /^[A-Za-z0-9._/:=,+@%~-]+$/;

/**
 * Canonical form of a blocklist: each entry trimmed, inner whitespace
 * collapsed to one space, exact duplicates dropped (first kept, order
 * preserved). An entry is a command prefix of words, not an expression:
 * no quote, no shell metacharacter, a command name first (no path, no
 * assignment, never `sudo` or `command`, which the matcher skips).
 */
export function normalizeCommandBlocklist(input: unknown): CommandBlocklistResult {
  if (!Array.isArray(input)) return { ok: false, issue: "not_text", index: null };
  const entries: string[] = [];
  for (const [index, raw] of input.entries()) {
    if (typeof raw !== "string") return { ok: false, issue: "not_text", index };
    const entry = raw.trim().replace(/\s+/g, " ");
    if (!entry) return { ok: false, issue: "empty", index };
    if (entry.length > COMMAND_BLOCKLIST_MAX_LENGTH) return { ok: false, issue: "too_long", index };
    const [first = "", ...rest] = entry.split(" ");
    if (!rest.every((word) => OTHER_WORD.test(word)) || !OTHER_WORD.test(first)) return { ok: false, issue: "characters", index };
    if (!FIRST_WORD.test(first) || first === "sudo" || first === "command") return { ok: false, issue: "command_name", index };
    if (!entries.includes(entry)) entries.push(entry);
  }
  if (entries.length > COMMAND_BLOCKLIST_MAX_ENTRIES) return { ok: false, issue: "too_many", index: null };
  return { ok: true, entries };
}

/** PERM2-11: the stages of the permission pipeline, in pipeline order. */
export const PERMISSION_DECISION_STAGES = [
  "forbidden", "floor", "opaque", "deletion", "tool_policy", "grant", "review", "full", "human", "unattended",
] as const;

export type PermissionDecisionStage = (typeof PERMISSION_DECISION_STAGES)[number];

/** Who answered: a member, an agency operator, or a policy (pipeline or reviewer). `null`: nobody yet. */
export type PermissionDecider = "member" | "agency" | "policy";

/**
 * PERM2-11, tenant side: why a gate of the decision journal was decided the
 * way it was. Every field comes from a closed set; never the command, the
 * gate arguments, the description or the reviewer's own words.
 */
export const DECISION_TRACE_STAGES = PERMISSION_DECISION_STAGES;

export type DecisionTraceStage = (typeof DECISION_TRACE_STAGES)[number];

/**
 * The pipeline's reason codes (`permission-decision.ts`) and the reviewer's
 * (`approval-review.ts`). The reviewer's technical failures (runtime busy,
 * unreadable verdict...) all read `review_failed` here.
 */
export const DECISION_TRACE_REASONS = [
  "tool_blocked", "plan_write", "tool_forbidden", "command_unreadable", "command_blocklisted",
  "gate_unidentified", "descriptor_missing", "sensitive_path", "circuit_breaker", "no_once_choice",
  "plan_mode", "manual_mode", "opaque_operation", "deletion", "tool_ask", "tool_always",
  "grant", "terminal_switch", "full_access", "never_wait",
  "review_approve", "review_deny", "review_escalated", "review_timeout", "review_circuit_open", "review_failed",
] as const;

export type DecisionTraceReason = (typeof DECISION_TRACE_REASONS)[number];

/** The pre-approval that answered a gate: a grant of this tool on this bot, or the runtime terminal switch. */
export type DecisionTraceGrantDto = {
  kind: "bot_tool" | "runtime_terminal";
  /** Who recorded it; `null` when it can no longer be told (the switch changed since). */
  authorName: string | null;
  authorKind: "member" | "agency" | null;
  /** `true`: recorded by a « Toujours » answer on a gate. */
  fromAlways: boolean;
  createdAt: string | null;
  /** Revoked since this decision. */
  revoked: boolean;
};

export type DecisionTraceDto = {
  /** `null`: a gate decided before the pipeline recorded its trace. */
  stage: DecisionTraceStage | null;
  decidedBy: PermissionDecider | null;
  /** The person, for a member or an agency operator. */
  deciderName: string | null;
  reason: DecisionTraceReason | null;
  /** `unattended`: the stage and reason that held the gate for nobody. */
  heldBy: { stage: DecisionTraceStage | null; reason: DecisionTraceReason | null } | null;
  grant: DecisionTraceGrantDto | null;
  /** A human « Toujours »: what it recorded, and whether it was saved. */
  always: { choice: "always_bot_tool" | "always_runtime_terminal"; saved: boolean } | null;
  /** A human `once` an interdiction set in the meantime sent as `deny`. */
  humanOverridden: DecisionTraceReason | null;
  /** A policy answer refused because the policy changed before forwarding. */
  policyChanged: boolean;
};

/**
 * La politique d'approbation d'openedbot pour ce bot (pas `approvals.mode` de
 * l'hôte, qui reste `manual`) : `manual` laisse chaque demande à
 * l'opérateur, `auto` et `bypass` laissent le worker y répondre, `plan`
 * demande un plan avant d'agir.
 */
export const BOT_PERMISSION_MODES = ["auto", "manual", "plan", "bypass"] as const;

export type BotPermissionMode = (typeof BOT_PERMISSION_MODES)[number];
