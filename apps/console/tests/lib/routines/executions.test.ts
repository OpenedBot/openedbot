import { describe, expect, test } from "bun:test";
import type { RoutineExecutionDto, WorkflowStatus } from "@openedbot/contracts-api";
import { executionReason, groupExecutions, isLiveRunStatus, runStatusTone } from "../../../src/lib/routines/executions";

let next = 0;
function execution(patch: Partial<RoutineExecutionDto> = {}): RoutineExecutionDto {
  next += 1;
  return {
    id: `e-${next}`, routineId: "r-1", outcome: "fired", trigger: "scheduled", missedCount: 0, busyRetries: null,
    errorCode: null, errorMessage: null, workflowId: null, runId: null, threadId: null, workflowStatus: null,
    createdAt: `2026-11-12T10:${String(next % 60).padStart(2, "0")}:00.000Z`,
    ...patch,
  };
}

const deferred = (busyRetries: number | null, patch: Partial<RoutineExecutionDto> = {}) =>
  execution({ outcome: "deferred", busyRetries, ...patch });

describe("groupExecutions", () => {
  test("folds the consecutive deferrals of one occurrence into one entry", () => {
    // Newest first, as the API pages them.
    const rows = [
      execution({ outcome: "fired" }),
      deferred(3), deferred(2), deferred(1),
      execution({ outcome: "fired" }),
      deferred(1),
    ];
    const entries = groupExecutions(rows);
    expect(entries.map((entry) => entry.rows.length)).toEqual([1, 3, 1, 1]);
    expect(entries[1]!.rows.map((row) => row.busyRetries)).toEqual([3, 2, 1]);
  });

  test("a reset busy counter starts another occurrence (an edit moved the clock)", () => {
    const entries = groupExecutions([deferred(2), deferred(1), deferred(4), deferred(3)]);
    expect(entries.map((entry) => entry.rows.length)).toEqual([2, 2]);
  });

  test("fire failures (no busy counter) fold with the deferrals around them", () => {
    const entries = groupExecutions([
      deferred(null, { errorCode: "ROUTINE_FIRE_FAILED" }),
      deferred(null, { errorCode: "ROUTINE_FIRE_FAILED" }),
      deferred(2),
    ]);
    expect(entries.map((entry) => entry.rows.length)).toEqual([3]);
  });

  test("150 deferrals of a one-shot are one line", () => {
    const rows = Array.from({ length: 150 }, (_, index) => deferred(150 - index));
    expect(groupExecutions(rows)).toHaveLength(1);
  });
});

describe("run status", () => {
  test("only a completed run is green; a failure never is", () => {
    const tones = Object.fromEntries((["queued", "running", "awaiting_approval", "reconciling", "completed", "failed", "cancelled", "expired", "unknown"] as WorkflowStatus[])
      .map((status) => [status, runStatusTone(status)]));
    expect(tones).toEqual({
      queued: "info", running: "info", awaiting_approval: "warning", reconciling: "warning",
      completed: "success", failed: "danger", cancelled: "neutral", expired: "danger", unknown: "warning",
    });
    expect(isLiveRunStatus("running")).toBe(true);
    expect(isLiveRunStatus("completed")).toBe(false);
    expect(isLiveRunStatus(null)).toBe(false);
  });
});

describe("executionReason", () => {
  test("maps the known codes to messages, keeps the API text for others", () => {
    expect(executionReason(deferred(1), false)).toEqual({ kind: "message", key: "botRoutinesDialog.executions.reasonBusy", error: false });
    expect(executionReason(deferred(12), true)).toMatchObject({ key: "botRoutinesDialog.executions.reasonBusySlow" });
    expect(executionReason(deferred(12), false)).toMatchObject({ key: "botRoutinesDialog.executions.reasonBusy" });
    const exhausted = execution({ outcome: "abandoned", errorCode: "ROUTINE_BUSY_RETRIES_EXHAUSTED", errorMessage: "brut" });
    expect(executionReason(exhausted, false)).toMatchObject({ key: "botRoutinesDialog.executions.errorBusyExhausted", error: true });
    expect(executionReason(exhausted, true)).toMatchObject({ key: "botRoutinesDialog.executions.errorBusyExhaustedOneShot" });
    expect(executionReason(execution({ outcome: "group_empty", errorCode: "GROUP_EMPTY" }), false))
      .toMatchObject({ key: "botRoutinesDialog.executions.errorGroupEmpty" });
    expect(executionReason(deferred(null, { errorCode: "ROUTINE_FIRE_FAILED" }), false))
      .toMatchObject({ key: "botRoutinesDialog.executions.errorFireFailed" });
    expect(executionReason(execution({ outcome: "abandoned", errorCode: "ROUTINE_FIRE_FAILED" }), false))
      .toMatchObject({ key: "botRoutinesDialog.executions.errorFireFailedAbandoned" });
    expect(executionReason(execution({ errorCode: "ROUTINE_HOST_OFFLINE" }), false)).toMatchObject({ key: "botRoutinesDialog.hostOffline" });
    expect(executionReason(execution({ errorCode: "SOMETHING_NEW", errorMessage: "Texte de l’API" }), false))
      .toEqual({ kind: "raw", text: "Texte de l’API", error: true });
    expect(executionReason(execution({ errorCode: "SOMETHING_NEW" }), false)).toEqual({ kind: "raw", text: "SOMETHING_NEW", error: true });
    expect(executionReason(execution(), false)).toBeNull();
  });
});
