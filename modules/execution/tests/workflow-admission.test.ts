import { describe, expect, test } from "bun:test";
import { WORKFLOW_ADMISSION_GRACE_SECONDS, workflowAdmissionDeadline } from "../src/domain/workflow-admission";

const at = (iso: string) => new Date(iso);

describe("workflowAdmissionDeadline", () => {
  test("a workflow that never started may wait its grace from when it was queued", () => {
    // Queued at 10:00 with a 30 min budget: deadline 10:30, admission until 12:00.
    expect(workflowAdmissionDeadline({ startedAt: null, deadlineAt: at("2026-11-07T10:30:00Z"), timeoutSeconds: 1800 }))
      .toEqual(at("2026-11-07T12:00:00Z"));
    expect(WORKFLOW_ADMISSION_GRACE_SECONDS).toBe(7200);
  });

  test("a started workflow keeps its execution deadline, never extended", () => {
    expect(workflowAdmissionDeadline({ startedAt: at("2026-11-07T10:05:00Z"), deadlineAt: at("2026-11-07T10:30:00Z"), timeoutSeconds: 1800 }))
      .toEqual(at("2026-11-07T10:30:00Z"));
  });

  test("the grace never shortens a budget longer than itself", () => {
    expect(workflowAdmissionDeadline({ startedAt: null, deadlineAt: at("2026-11-07T13:00:00Z"), timeoutSeconds: 3 * 3600 }))
      .toEqual(at("2026-11-07T13:00:00Z"));
  });
});
