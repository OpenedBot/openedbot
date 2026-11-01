import { describe, expect, test } from "bun:test";
import type { ApprovalRequestDto, RunDto } from "@openedbot/contracts-api";
import { liveApprovals } from "../../../src/lib/run/live-approvals";

function approval(overrides: Partial<ApprovalRequestDto>): ApprovalRequestDto {
  return {
    id: "a1",
    runId: "r1",
    threadId: "t1",
    kind: "tool",
    action: "execute_code",
    detail: null,
    choices: ["once", "deny"],
    status: "pending",
    requestedAt: "2026-10-25T00:00:00.000Z",
    respondedAt: null,
    ...overrides,
  };
}

const run = (id: string, status: RunDto["status"]) => ({ id, status });

describe("liveApprovals", () => {
  test("keeps a pending gate on an executing run, same array reference", () => {
    const approvals = [approval({})];
    expect(liveApprovals(approvals, [run("r1", "awaiting_approval")])).toBe(approvals);
  });

  test("drops a pending gate once its run is concluded", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(liveApprovals([approval({})], [run("r1", status)])).toEqual([]);
    }
  });

  test("drops a gate that is no longer pending", () => {
    expect(liveApprovals([approval({ status: "denied" })], [run("r1", "running")])).toEqual([]);
  });

  test("a run missing from the snapshot does not conclude the gate", () => {
    const approvals = [approval({})];
    expect(liveApprovals(approvals, [])).toBe(approvals);
  });
});
