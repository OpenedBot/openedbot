import { describe, expect, test } from "bun:test";
import { workflowDeadlinePassed, workflowRemainingMs } from "../../src/application/runner/admission";
import { createRunState } from "../../src/application/runner/run-state";

const NOW = Date.parse("2026-11-06T10:00:00Z");

describe("workflowDeadlinePassed", () => {
  test("sans échéance, ou en réconciliation, rien n'est dépassé", () => {
    expect(workflowDeadlinePassed({ workflowStatus: "running", workflowDeadlineAt: null }, NOW)).toBe(false);
    expect(workflowDeadlinePassed({ workflowStatus: "reconciling", workflowDeadlineAt: new Date(NOW - 1) }, NOW)).toBe(false);
  });

  test("l'échéance atteinte compte comme dépassée, en chaîne comme en date", () => {
    expect(workflowDeadlinePassed({ workflowStatus: "running", workflowDeadlineAt: new Date(NOW) }, NOW)).toBe(true);
    expect(workflowDeadlinePassed({ workflowStatus: "queued", workflowDeadlineAt: "2026-11-06T09:59:59Z" }, NOW)).toBe(true);
    expect(workflowDeadlinePassed({ workflowStatus: "running", workflowDeadlineAt: new Date(NOW + 1) }, NOW)).toBe(false);
  });
});

describe("workflowRemainingMs", () => {
  test("borne le délai du run par l'échéance du workflow", () => {
    expect(workflowRemainingMs({ workflowStatus: "running", workflowDeadlineAt: new Date(NOW + 5_000) }, NOW)).toBe(5_000);
    expect(workflowRemainingMs({ workflowStatus: "running", workflowDeadlineAt: "2026-11-06T09:59:58Z" }, NOW)).toBe(-2_000);
  });

  test("hors workflow ou en réconciliation, aucune borne", () => {
    expect(workflowRemainingMs({ workflowStatus: null, workflowDeadlineAt: null }, NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(workflowRemainingMs({ workflowStatus: "reconciling", workflowDeadlineAt: new Date(NOW + 1) }, NOW))
      .toBe(Number.POSITIVE_INFINITY);
  });
});

describe("createRunState", () => {
  test("part de l'identifiant réclamé et d'un arrêt déjà demandé", () => {
    const resumed = createRunState({ hermesRunId: "hermes-1", remoteStopState: "requested" });
    expect(resumed.hermesRunId).toBe("hermes-1");
    expect(resumed.cancelRequested).toBe(true);
    expect(resumed.controller.signal.aborted).toBe(false);
    const fresh = createRunState({ hermesRunId: null, remoteStopState: null });
    expect(fresh).toMatchObject({
      hermesRunId: null,
      selection: null,
      createArgs: null,
      terminal: false,
      cancelRequested: false,
      idleTimedOut: false,
      runTimedOut: false,
      approvalExpired: false,
      retryState: { fallbackAttempted: false, extraModelTried: false, fromProvider: null, fallback: null },
    });
  });
});
