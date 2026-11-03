import {
  DECISION_TRACE_REASONS,
  DECISION_TRACE_STAGES,
  type DecisionTraceDto,
  type DecisionTraceGrantDto,
  type DecisionTraceReason,
  type DecisionTraceStage,
  type PermissionDecider,
} from "@openedbot/contracts-api";
import { isoInstant } from "@openedbot/contracts-primitives";

/**
 * PERM2-11: the columns of the decision journal row that say who or what
 * decided a gate. The SQL reads named keys of `decision_detail` one by one,
 * never the object: a key added to it later cannot reach the tenant.
 */
export type DecisionTraceRow = {
  traceStage?: string | null;
  decidedByKind?: string | null;
  deciderName?: string | null;
  traceReason?: string | null;
  heldStage?: string | null;
  heldReason?: string | null;
  always?: string | null;
  alwaysRecorded?: boolean | null;
  grantError?: string | null;
  humanOverridden?: string | null;
  policyChanged?: boolean | null;
  grantKind?: string | null;
  grantAuthorName?: string | null;
  grantAuthorKind?: string | null;
  grantFromAlways?: boolean | null;
  grantCreatedAt?: Date | string | null;
  grantRevoked?: boolean | null;
};

const DECIDERS: readonly PermissionDecider[] = ["member", "agency", "policy"];
/** The reviewer's technical failures: the tenant reads one copy for all of them. */
const REVIEW_FAILURES: ReadonlySet<string> = new Set([
  "review_failed", "review_runtime_missing", "review_profile_stale", "review_runtime_busy",
  "review_unreadable", "review_run_failed", "review_pipeline_legacy", "review_unavailable",
]);
/** A person's name, plain and bounded: it is shown, never interpreted. */
const NAME_MAX_CHARS = 120;

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? value as T : null;
}

/**
 * A stored reason code, in the closed list or `null`. The pipeline writes
 * `review` and `review_enforced` while a gate waits for the reviewer: a
 * decided row never keeps them, but if one does it reads as escalated, the
 * only way such a gate can have reached a person.
 */
export function traceReason(value: unknown): DecisionTraceReason | null {
  if (typeof value !== "string") return null;
  if (REVIEW_FAILURES.has(value)) return "review_failed";
  if (value === "review" || value === "review_enforced") return "review_escalated";
  return oneOf(DECISION_TRACE_REASONS, value);
}

function traceStage(value: unknown): DecisionTraceStage | null {
  return oneOf(DECISION_TRACE_STAGES, value);
}

function personName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\p{Cc}+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  return chars.length > NAME_MAX_CHARS ? chars.slice(0, NAME_MAX_CHARS).join("") : flat;
}

function grantOf(row: DecisionTraceRow): DecisionTraceGrantDto | null {
  const kind = row.grantKind === "bot_tool" || row.grantKind === "runtime_terminal" ? row.grantKind : null;
  if (!kind) return null;
  return {
    kind,
    authorName: personName(row.grantAuthorName),
    authorKind: row.grantAuthorKind === "member" || row.grantAuthorKind === "agency" ? row.grantAuthorKind : null,
    fromAlways: row.grantFromAlways === true,
    createdAt: row.grantCreatedAt ? isoInstant(row.grantCreatedAt) : null,
    revoked: row.grantRevoked === true,
  };
}

/**
 * The trace of one journal row, or `null` when nothing is known about it (a
 * legacy policy answer). A value outside its closed set becomes `null`.
 */
export function decisionTrace(row: DecisionTraceRow): DecisionTraceDto | null {
  const stage = traceStage(row.traceStage);
  const decidedBy = oneOf(DECIDERS, row.decidedByKind);
  // A policy has no name; a person's name is only told for a person.
  const deciderName = decidedBy === "policy" ? null : personName(row.deciderName);
  const reason = traceReason(row.traceReason);
  const heldStage = traceStage(row.heldStage);
  const heldReason = traceReason(row.heldReason);
  const alwaysChoice = row.always === "always_bot_tool" || row.always === "always_runtime_terminal" ? row.always : null;
  const trace: DecisionTraceDto = {
    stage,
    decidedBy,
    deciderName,
    reason,
    heldBy: stage === "unattended" && (heldStage || heldReason) ? { stage: heldStage, reason: heldReason } : null,
    grant: grantOf(row),
    always: alwaysChoice
      ? { choice: alwaysChoice, saved: row.alwaysRecorded === true && !row.grantError }
      : null,
    humanOverridden: traceReason(row.humanOverridden),
    policyChanged: row.policyChanged === true,
  };
  const known = trace.stage || trace.decidedBy || trace.deciderName || trace.reason || trace.grant || trace.always || trace.humanOverridden;
  return known ? trace : null;
}
