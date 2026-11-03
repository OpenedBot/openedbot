import { describe, expect, test } from "bun:test";
import { runAwaitsAnswer } from "../src/routes/conversation/approval-routes";

describe("a gate answer while its run is being resumed", () => {
  test("a run waiting at the gate takes the answer", () => {
    expect(runAwaitsAnswer({ status: "awaiting_approval", hermesRunId: "run_1" })).toBe(true);
  });

  test("a run requeued or reclaimed after a worker restart, its Hermes run parked at the gate, takes it too", () => {
    // Before: the gate was expired as inactive and nothing reached Hermes.
    expect(runAwaitsAnswer({ status: "queued", hermesRunId: "run_1" })).toBe(true);
    expect(runAwaitsAnswer({ status: "starting", hermesRunId: "run_1" })).toBe(true);
  });

  test("a run that never reached Hermes, a running or finished one, does not", () => {
    expect(runAwaitsAnswer({ status: "queued", hermesRunId: null })).toBe(false);
    for (const status of ["running", "completed", "failed", "cancelled", "unknown"]) {
      expect(runAwaitsAnswer({ status, hermesRunId: "run_1" })).toBe(false);
    }
    expect(runAwaitsAnswer(undefined)).toBe(false);
  });
});
