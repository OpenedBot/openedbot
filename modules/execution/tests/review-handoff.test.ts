import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { captureLogEvents } from "@openedbot/platform-observability/log/test-logger";
import { handOffReviewGates, REVIEW_HANDOFF_REASON } from "../src/application/review-handoff";

/**
 * Without an automatic reviewer (the plug-in `permissions`), a gate left
 * `reviewing` goes to a person, like an escalated review; on a "Never wait"
 * workflow it is refused at stage `unattended`. The claim never takes a gate
 * younger than `minAgeMs`, and a write needs the claim token.
 */
const ORG = "0b9c6a1e-0000-4000-8000-000000000001";
const GATE = { id: "gate-1", organizationId: ORG, runId: "run-1", workflowId: "wf-1", claimToken: "token-1" };

type Statement = { sql: string; values: unknown[] };

function fakeDb(options: { jobs?: Array<typeof GATE>; neverWait?: boolean; written?: boolean } = {}) {
  const statements: Statement[] = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push({ sql, values });
    if (sql.includes("decision_state = 'reviewing'") && sql.includes("for update skip locked")) return options.jobs ?? [GATE];
    if (sql.startsWith("select id from runs")) return [{ id: GATE.runId }];
    if (sql.startsWith("select id from workflows")) return [{ id: GATE.workflowId }];
    if (sql.includes("never_wait")) return [{ neverWait: options.neverWait === true }];
    if (sql.startsWith("update approval_requests")) return options.written === false ? [] : [{ id: GATE.id }];
    if (sql.startsWith("update workflows")) return [];
    throw new Error(`unexpected query: ${sql}`);
  };
  const db = Object.assign(tag, { begin: async (callback: (tx: unknown) => Promise<unknown>) => callback(tag) }) as unknown as SQL;
  return { db, statements };
}

describe("handOffReviewGates", () => {
  test("a gate left under review goes to a person and its workflow awaits approval", async () => {
    const { db, statements } = fakeDb();
    const { result, records } = await captureLogEvents(() => handOffReviewGates(db, { limit: 20, minAgeMs: 0 }));
    expect(result).toBe(1);
    const claim = statements[0]!;
    expect(claim.values).toEqual([0, 20, 25]);
    const update = statements.find((entry) => entry.sql.startsWith("update approval_requests"))!;
    expect(update.sql).toContain("decision_state = 'awaiting_human', decision_stage = 'review'");
    expect(update.sql).toContain("decision_claim_token = ? and status = 'pending' and decision_state = 'reviewing'");
    expect(update.values).toContainEqual({ reason: REVIEW_HANDOFF_REASON });
    expect(statements.some((entry) => entry.sql.startsWith("update workflows") && entry.sql.includes("'awaiting_approval'"))).toBe(true);
    // The run, then the workflow, then the gate: the forwarder's lock order.
    const order = statements.slice(1).map((entry) => entry.sql.split(" ").slice(0, 4).join(" "));
    expect(order.slice(0, 2)).toEqual(["select id from runs", "select id from workflows"]);
    expect(records).toContainEqual(expect.objectContaining({ event: "approval.decision", stage: "review", outcome: "human", reason: REVIEW_HANDOFF_REASON, reviewer: false }));
  });

  test("on a \"Never wait\" workflow the gate is refused at stage unattended, nobody is notified", async () => {
    const { db, statements } = fakeDb({ neverWait: true });
    const { records } = await captureLogEvents(() => handOffReviewGates(db, { limit: 20, minAgeMs: 0 }));
    const update = statements.find((entry) => entry.sql.startsWith("update approval_requests"))!;
    expect(update.sql).toContain("status = 'denied', selected_choice = 'deny'");
    expect(update.sql).toContain("decision_stage = 'unattended'");
    expect(statements.some((entry) => entry.sql.startsWith("update workflows"))).toBe(false);
    expect(records).toContainEqual(expect.objectContaining({ event: "approval.decision", outcome: "deny", reason: "never_wait", heldReason: REVIEW_HANDOFF_REASON }));
  });

  test("a gate answered meanwhile (token or state moved) is not rewritten, and its workflow is left alone", async () => {
    const { db, statements } = fakeDb({ written: false });
    expect(await handOffReviewGates(db, { limit: 20, minAgeMs: 0 })).toBe(0);
    expect(statements.some((entry) => entry.sql.startsWith("update workflows"))).toBe(false);
  });

  test("the grace is passed to the claim, and an aborted pass claims nothing", async () => {
    const { db, statements } = fakeDb({ jobs: [] });
    expect(await handOffReviewGates(db, { limit: 5, minAgeMs: 120_000 })).toBe(0);
    expect(statements[0]!.values).toEqual([120_000, 5, 25]);
    const aborted = new AbortController();
    aborted.abort();
    const idle = fakeDb();
    expect(await handOffReviewGates(idle.db, { limit: 5, minAgeMs: 0, signal: aborted.signal })).toBe(0);
    expect(idle.statements).toEqual([]);
  });

  test("a gate whose hand-off fails is logged and left to its lease; the others go on", async () => {
    const second = { ...GATE, id: "gate-2", runId: "run-2" };
    const { db } = fakeDb({ jobs: [{ ...GATE, runId: "boom" }, second] });
    const failing = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes("from runs") && values.includes("boom")) throw new Error("lock timeout");
      return (db as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(strings, ...values);
    }, { begin: async (callback: (tx: unknown) => Promise<unknown>) => callback(failing) }) as unknown as SQL;
    const { result, records } = await captureLogEvents(() => handOffReviewGates(failing, { limit: 20, minAgeMs: 0 }));
    expect(result).toBe(1);
    expect(records).toContainEqual(expect.objectContaining({ event: "approval.review_handoff_failed", runId: "boom", error: "lock timeout" }));
  });
});
