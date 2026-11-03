import { describe, expect, test } from "bun:test";
import { DECISION_TRACE_REASONS } from "@openedbot/contracts-api";
import { decisionTrace, traceReason } from "../src/domain/decision-trace";

describe("decisionTrace", () => {
  test("a gate the grant answered names the grant, its author and that it came from Always", () => {
    expect(decisionTrace({
      traceStage: "grant",
      decidedByKind: "policy",
      deciderName: "should not show",
      traceReason: "grant",
      grantKind: "bot_tool",
      grantAuthorName: "Camille Lefèvre",
      grantAuthorKind: "member",
      grantFromAlways: true,
      grantCreatedAt: new Date("2026-10-12T09:00:00.000Z"),
      grantRevoked: false,
    })).toEqual({
      stage: "grant",
      decidedBy: "policy",
      deciderName: null,
      reason: "grant",
      heldBy: null,
      grant: {
        kind: "bot_tool",
        authorName: "Camille Lefèvre",
        authorKind: "member",
        fromAlways: true,
        createdAt: "2026-10-12T09:00:00.000Z",
        revoked: false,
      },
      always: null,
      humanOverridden: null,
      policyChanged: false,
    });
  });

  test("a gate the floor held and a person refused says the rule and the person", () => {
    expect(decisionTrace({
      traceStage: "floor", decidedByKind: "member", deciderName: "Camille Lefèvre", traceReason: "sensitive_path",
    })).toMatchObject({ stage: "floor", decidedBy: "member", deciderName: "Camille Lefèvre", reason: "sensitive_path", grant: null });
  });

  test("an unattended refusal says which stage held the gate", () => {
    expect(decisionTrace({ traceStage: "unattended", decidedByKind: "policy", traceReason: "never_wait", heldStage: "floor", heldReason: "circuit_breaker" }))
      .toMatchObject({ stage: "unattended", reason: "never_wait", heldBy: { stage: "floor", reason: "circuit_breaker" } });
  });

  test("a human Always is said, saved or not", () => {
    expect(decisionTrace({ traceStage: "human", decidedByKind: "agency", deciderName: "Camille", traceReason: "manual_mode", always: "always_bot_tool", alwaysRecorded: true })?.always)
      .toEqual({ choice: "always_bot_tool", saved: true });
    expect(decisionTrace({ traceStage: "human", decidedByKind: "member", always: "always_runtime_terminal", alwaysRecorded: false, grantError: "RUNTIME_NOT_FOUND" })?.always)
      .toEqual({ choice: "always_runtime_terminal", saved: false });
  });

  test("a value outside its closed set never crosses", () => {
    const trace = decisionTrace({
      traceStage: "secret_stage", decidedByKind: "root", deciderName: "Camille", traceReason: "rm -rf /home/acme",
      heldStage: "x", heldReason: "y", always: "always_everything", humanOverridden: "cat ~/.ssh/id_rsa", grantKind: "everything",
    });
    expect(trace).toEqual({
      stage: null, decidedBy: null, deciderName: "Camille", reason: null, heldBy: null, grant: null,
      always: null, humanOverridden: null, policyChanged: false,
    });
  });

  test("a legacy policy row with nothing known has no trace", () => {
    expect(decisionTrace({})).toBeNull();
    expect(decisionTrace({ traceStage: null, decidedByKind: null, deciderName: "  ", traceReason: null })).toBeNull();
  });

  test("a name is one plain bounded line", () => {
    const trace = decisionTrace({ decidedByKind: "member", deciderName: `Camille\u0000\nLefèvre${"x".repeat(400)}` });
    expect(trace?.deciderName?.startsWith("Camille Lefèvre")).toBe(true);
    expect(Array.from(trace?.deciderName ?? "").length).toBe(120);
  });
});

describe("traceReason", () => {
  test("the reviewer's technical failures read as one", () => {
    for (const code of ["review_runtime_busy", "review_unreadable", "review_profile_stale", "review_failed"]) {
      expect(traceReason(code)).toBe("review_failed");
    }
    expect(traceReason("review_deny")).toBe("review_deny");
    expect(traceReason("review")).toBe("review_escalated");
  });

  test("every code of the closed list maps to itself", () => {
    for (const code of DECISION_TRACE_REASONS) expect(traceReason(code)).toBe(code);
  });
});
