import { describe, expect, test } from "bun:test";
import type { TransactionDb } from "@openedbot/platform-db";
import { cancelMaintenanceRunsTx, isMaintenanceStepKind, requestRunCancellationTx, requestWorkflowCancellationTx } from "../src/application/run-cancellation";

type Call = { sql: string; values: unknown[] };

type RunFixture = {
  id: string;
  originRunId: string | null;
  botId: string | null;
  status: string;
  workflowId: string | null;
  hermesRunId: string | null;
  externalState: string;
};

const baseRun: RunFixture = {
  id: "run-1",
  originRunId: null,
  botId: "bot-1",
  status: "running",
  workflowId: "workflow-1",
  hermesRunId: "hermes-1",
  externalState: "streaming",
};

describe("durable run cancellation", () => {
  test("locks an inbound handoff before its courier without pre-locking the requested run", async () => {
    const calls: Call[] = [];
    const child: RunFixture = {
      ...baseRun,
      id: "run-child",
      originRunId: "run-courier",
      workflowId: null,
    };
    const courier: RunFixture = {
      ...baseRun,
      id: "run-courier",
      originRunId: null,
      botId: null,
      status: "relaying",
      workflowId: null,
      hermesRunId: null,
      externalState: "not_started",
    };
    const tx = fakeRunTx(calls, [child, courier]);

    const result = await requestRunCancellationTx(tx, "org-1", courier.id, {
      code: "CANCELLED_BY_USER",
      message: "Run annulé.",
    });

    const locks = calls.filter(({ sql }) => sql.includes("with requested as") && sql.includes("for update of run"));
    expect(locks).toHaveLength(2);
    expect(locks[0]?.sql).toContain("order by (run.origin_run_id is null), run.id");
    expect(calls.some(({ sql }) =>
      sql.startsWith('select workflow_id as "workflowId" from runs') && sql.includes("for update"))).toBe(false);
    expect(result.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: child.id, status: "requested" },
      { id: courier.id, status: "cancelled" },
    ]);
  });

  test("terminalizes work that provably never crossed the Hermes boundary", async () => {
    const calls: Call[] = [];
    const tx = fakeTx(calls, { ...baseRun, status: "queued", hermesRunId: null, externalState: "not_started" });

    const result = await requestWorkflowCancellationTx(tx, "org-1", "workflow-1", {
      code: "CANCELLED_BY_USER",
      message: "Workflow annulé.",
    });

    expect(result).toEqual([expect.objectContaining({ id: "run-1", status: "cancelled" })]);
    expect(calls.some(({ sql }) => sql.includes("update runs set status = 'cancelled'") && sql.includes("external_state = 'settled'"))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("update workflows set status = 'cancelled'"))).toBe(true);
  });

  test("keeps a known Hermes run active until the worker confirms its terminal state", async () => {
    const calls: Call[] = [];
    const tx = fakeTx(calls, baseRun);

    const result = await requestWorkflowCancellationTx(tx, "org-1", "workflow-1", {
      code: "CANCELLED_BY_USER",
      message: "Workflow annulé.",
    });

    expect(result[0]?.status).toBe("requested");
    expect(calls.some(({ sql }) => sql.includes("external_state = 'stopping'") && sql.includes("remote_stop_state = 'requested'"))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("update workflows set status = 'cancelled'"))).toBe(false);
    expect(calls.some(({ sql }) => sql.includes("error_code = 'CANCEL_REQUESTED'"))).toBe(true);
  });

  test("exposes a create without Hermes id as unknown instead of pretending it stopped", async () => {
    const calls: Call[] = [];
    const tx = fakeTx(calls, { ...baseRun, hermesRunId: null, externalState: "creating" });

    const result = await requestWorkflowCancellationTx(tx, "org-1", "workflow-1", {
      code: "CANCELLED_BY_USER",
      message: "Workflow annulé.",
    });

    expect(result[0]?.status).toBe("unknown");
    expect(calls.some(({ sql }) => sql.includes("update runs set status = 'unknown'") && sql.includes("external_state = 'ambiguous'"))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("update workflows set status = 'unknown'") && sql.includes("needsReview"))).toBe(false);
    expect(calls.some(({ sql, values }) => sql.includes("update workflows set status = 'unknown'") &&
      values.some((value) => typeof value === "object" && value !== null && "needsReview" in value))).toBe(true);
  });

  test("an approval already being forwarded forces review and follows run→workflow→gate lock order", async () => {
    const calls: Call[] = [];
    const tx = fakeTx(calls, baseRun, true);

    const result = await requestWorkflowCancellationTx(tx, "org-1", "workflow-1", {
      code: "CANCELLED_BY_USER",
      message: "Workflow annulé.",
    });

    expect(result[0]?.status).toBe("unknown");
    const runLock = calls.findIndex(({ sql }) => sql.includes("from runs") && sql.includes("for update"));
    const workflowLock = calls.findIndex(({ sql }) => sql.includes("select id from workflows") && sql.includes("for update"));
    const gateLock = calls.findIndex(({ sql }) => sql.includes("select run_id") && sql.includes("for update"));
    expect(runLock).toBeLessThan(workflowLock);
    expect(workflowLock).toBeLessThan(gateLock);
    expect(calls.some(({ sql }) => sql.includes("forward_state = case when forward_state = 'sending' then 'ambiguous'"))).toBe(true);
  });

  test("annule une passe mémoire avec run.error, sans laisser le run actif", async () => {
    expect(isMaintenanceStepKind("memory")).toBe(true);
    expect(isMaintenanceStepKind("compaction")).toBe(true);
    expect(isMaintenanceStepKind("root")).toBe(false);
    const calls: Call[] = [];
    const tx = fakeTx(calls, baseRun);
    await cancelMaintenanceRunsTx(tx, "org-1", [{ id: "run-memory", threadId: "thread-1" }], {
      code: "CANCELLED_BY_DELETE",
      message: "Passe de maintenance annulée : le bot est supprimé.",
    });
    expect(calls.some(({ sql }) => sql.includes("openedbot-run-events-cursor"))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("update runs set status = 'cancelled'") && sql.includes("external_state = 'settled'"))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("insert into run_events") && sql.includes("'run.error'"))).toBe(true);
  });
});

function fakeTx(calls: Call[], row: RunFixture, sending = false): TransactionDb {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!(strings as TemplateStringsArray & { raw?: readonly string[] }).raw) return Promise.resolve([]);
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    calls.push({ sql, values });
    if (sql.includes('select id, origin_run_id as "originRunId"') && sql.includes("workflow_id =")) {
      return Promise.resolve([row]);
    }
    if (sql.includes("select id from workflows") && sql.includes("for update")) {
      return Promise.resolve([{ id: "workflow-1" }]);
    }
    if (sql.includes("select run_id") && sql.includes("forward_state = 'sending'")) {
      return Promise.resolve(sending ? [{ runId: "run-1" }] : []);
    }
    return Promise.resolve([]);
  }) as unknown as TransactionDb;
  return tag;
}

function fakeRunTx(calls: Call[], rows: RunFixture[]): TransactionDb {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!(strings as TemplateStringsArray & { raw?: readonly string[] }).raw) return Promise.resolve([]);
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    calls.push({ sql, values });
    if (sql.includes("with requested as") && sql.includes("for update of run")) {
      return Promise.resolve(rows);
    }
    return Promise.resolve([]);
  }) as unknown as TransactionDb;
  return tag;
}
