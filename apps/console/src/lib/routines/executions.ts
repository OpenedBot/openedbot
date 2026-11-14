import type { RoutineExecutionDto, WorkflowStatus } from "@openedbot/contracts-api";
import { ROUTINE_LIMITS } from "@openedbot/execution/domain/routines";

/**
 * Same values as `ROUTINE_ERROR_*` of `@openedbot/contracts-errors` and the
 * run-now refusal of `routine-routes.ts`: the console does not depend on
 * that package, and a code it does not know falls back to the API's text.
 */
export const ROUTINE_ERROR_CODES = {
  busyRetriesExhausted: "ROUTINE_BUSY_RETRIES_EXHAUSTED",
  groupEmpty: "GROUP_EMPTY",
  fireFailed: "ROUTINE_FIRE_FAILED",
  hostOffline: "ROUTINE_HOST_OFFLINE",
} as const;

/**
 * One line of the history. Consecutive deferrals of one occurrence fold
 * into a single entry: a reminder on a busy thread can defer ~150 times.
 * `rows` is newest first, as the API pages them.
 */
export type ExecutionEntry = { key: string; rows: [RoutineExecutionDto, ...RoutineExecutionDto[]] };

/**
 * Whether `older` (the row just below `newer`) still defers the same
 * occurrence. Every occurrence ends on a non-deferred row (fired, catch-up,
 * abandoned, empty room), so a run of deferrals never spans two of them;
 * the busy counter only grows within one, and an edit of the schedule resets
 * it without a history row, hence the second test.
 */
function sameDeferral(newer: RoutineExecutionDto, older: RoutineExecutionDto): boolean {
  if (newer.outcome !== "deferred" || older.outcome !== "deferred") return false;
  if (newer.trigger !== older.trigger) return false;
  if (newer.busyRetries !== null && older.busyRetries !== null && older.busyRetries >= newer.busyRetries) return false;
  return true;
}

export function groupExecutions(rows: readonly RoutineExecutionDto[]): ExecutionEntry[] {
  const entries: ExecutionEntry[] = [];
  for (const row of rows) {
    const current = entries[entries.length - 1];
    const last = current?.rows[current.rows.length - 1];
    if (current && last && sameDeferral(last, row)) current.rows.push(row);
    else entries.push({ key: row.id, rows: [row] });
  }
  return entries;
}

export type StatusTone = "success" | "info" | "neutral" | "warning" | "danger";

/** A finished run is green only when it completed; a failure never is. */
export function runStatusTone(status: WorkflowStatus): StatusTone {
  switch (status) {
    case "completed": return "success";
    case "queued":
    case "running": return "info";
    case "awaiting_approval":
    case "reconciling":
    case "unknown": return "warning";
    case "failed":
    case "expired": return "danger";
    case "cancelled": return "neutral";
  }
}

const LIVE_STATUSES: ReadonlySet<WorkflowStatus> = new Set(["queued", "running", "awaiting_approval", "reconciling"]);

export function isLiveRunStatus(status: WorkflowStatus | null): boolean {
  return status !== null && LIVE_STATUSES.has(status);
}

export type ExecutionReason =
  | {
    kind: "message";
    key:
      | "botRoutinesDialog.executions.reasonBusy"
      | "botRoutinesDialog.executions.reasonBusySlow"
      | "botRoutinesDialog.executions.errorBusyExhausted"
      | "botRoutinesDialog.executions.errorBusyExhaustedOneShot"
      | "botRoutinesDialog.executions.errorGroupEmpty"
      | "botRoutinesDialog.executions.errorFireFailed"
      | "botRoutinesDialog.executions.errorFireFailedAbandoned"
      | "botRoutinesDialog.hostOffline";
    error: boolean;
  }
  | { kind: "raw"; text: string; error: true };

/**
 * Why a row deferred or failed, as an i18n message for the codes the
 * console knows; any other code keeps the API's own message (or the code).
 * `error: false` is a wait, not a failure: a busy thread.
 */
export function executionReason(row: RoutineExecutionDto, oneShot: boolean): ExecutionReason | null {
  const message = (key: Extract<ExecutionReason, { kind: "message" }>["key"], error = true): ExecutionReason =>
    ({ kind: "message", key, error });
  switch (row.errorCode) {
    case null:
      if (row.outcome !== "deferred") return row.errorMessage ? { kind: "raw", text: row.errorMessage, error: true } : null;
      return oneShot && (row.busyRetries ?? 0) > ROUTINE_LIMITS.maxBusyRetries
        ? message("botRoutinesDialog.executions.reasonBusySlow", false)
        : message("botRoutinesDialog.executions.reasonBusy", false);
    case ROUTINE_ERROR_CODES.busyRetriesExhausted:
      return message(oneShot
        ? "botRoutinesDialog.executions.errorBusyExhaustedOneShot"
        : "botRoutinesDialog.executions.errorBusyExhausted");
    case ROUTINE_ERROR_CODES.groupEmpty:
      return message("botRoutinesDialog.executions.errorGroupEmpty");
    case ROUTINE_ERROR_CODES.fireFailed:
      return message(row.outcome === "abandoned"
        ? "botRoutinesDialog.executions.errorFireFailedAbandoned"
        : "botRoutinesDialog.executions.errorFireFailed");
    case ROUTINE_ERROR_CODES.hostOffline:
      return message("botRoutinesDialog.hostOffline");
    default:
      return { kind: "raw", text: row.errorMessage ?? row.errorCode, error: true };
  }
}
