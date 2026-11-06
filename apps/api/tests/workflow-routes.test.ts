import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { insertedRow } from "../../../tests/sql-insert-columns";
import { readHistoryCursor, readHistoryFilter, readHistoryLimit, routinePublicFields, workflowRoutes } from "../src/routes/execution/workflow-routes";

const owner: AuthContext = {
  sessionId: "session-1",
  organizationId: "org-1",
  userId: "user-1",
  role: "owner",
  kind: "web",
  credentialHash: "credential",
};

describe("workflow DTO routine fields", () => {
  test("extrait routineId et trigger sans exposer recovery_state", () => {
    const routineId = "4e4a604d-b634-4105-a864-fe7d16d670ba";
    expect(routinePublicFields("routine", { routineId, trigger: "manual", secret: "nope" })).toEqual({
      routineId,
      trigger: "manual",
    });
    expect(routinePublicFields("dm", { routineId, trigger: "manual" })).toEqual({});
    expect(routinePublicFields("routine", { trigger: "other" })).toEqual({ routineId: null, trigger: null });
  });

  test("GET /:id pose routineId et trigger, recoveryState reste opaque", async () => {
    const calls: SqlCall[] = [];
    const routineId = "4e4a604d-b634-4105-a864-fe7d16d670ba";
    const response = await mount(workflowDtoDb(calls, {
      kind: "routine",
      status: "completed",
      recoveryState: { routineId, trigger: "scheduled", extra: true },
    })).request("/workflow-1");

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      kind: "routine",
      status: "completed",
      recoveryState: null,
      routineId,
      trigger: "scheduled",
    });
    expect(JSON.stringify(body)).not.toContain("extra");
  });

  test("la liste pose les mêmes champs pour un workflow de routine", async () => {
    const calls: SqlCall[] = [];
    const routineId = "4e4a604d-b634-4105-a864-fe7d16d670ba";
    const response = await mount(workflowHistoryDb(calls, {
      kind: "routine",
      status: "completed",
      recoveryState: { routineId, trigger: "manual" },
    })).request("/");

    expect(response.status).toBe(200);
    const body = await response.json() as { workflows: Array<Record<string, unknown>> };
    expect(body.workflows[0]).toMatchObject({
      kind: "routine",
      recoveryState: null,
      routineId,
      trigger: "manual",
    });
    expect(calls.some(({ sql }) => sql.includes("w.recovery_state as \"recoveryState\""))).toBe(true);
  });
});

describe("workflow recovery routes", () => {
  test("refuses reconciliation when the unknown run has no Hermes id", async () => {
    const calls: SqlCall[] = [];
    const response = await mount(recoveryDb(calls, { hermesRunId: null })).request(
      "/workflow-1/reconcile",
      { method: "POST" },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "WORKFLOW_RECONCILIATION_UNAVAILABLE" } });
    expect(calls.some(({ sql }) => sql.includes("update runs set status = 'queued'"))).toBe(false);
    expect(calls.some(({ sql }) => sql.includes("update workflows set status = 'reconciling'"))).toBe(false);
  });

  test("allows an owner to abandon unknown work and releases its lease", async () => {
    const calls: SqlCall[] = [];
    const response = await mount(recoveryDb(calls)).request("/workflow-1/abandon", { method: "POST" });

    expect(response.status).toBe(204);
    const runUpdate = calls.findIndex(({ sql }) => sql.includes("update runs set status = 'failed'"));
    const workflowUpdate = calls.findIndex(({ sql }) => sql.includes("update workflows set status = 'failed'"));
    expect(runUpdate).toBeGreaterThanOrEqual(0);
    expect(runUpdate).toBeLessThan(workflowUpdate);
    expect(calls[runUpdate]?.sql).toContain("lease_owner = null");
    expect(calls[runUpdate]?.sql).toContain("lease_expires_at = null");
    expect(calls[runUpdate]?.sql).toContain("status = 'unknown'");
    expect(calls[workflowUpdate]?.sql).toContain("EXTERNAL_OUTCOME_ABANDONED");
    expect(calls[workflowUpdate]?.values).toContainEqual({ resolution: "abandoned", duplicateRisk: true });
  });

  test("abandonne aussi le run FIFO d'un steering ambigu", async () => {
    const calls: SqlCall[] = [];
    const response = await mount(recoveryDb(calls, { ambiguousSteer: true })).request(
      "/workflow-1/abandon",
      { method: "POST" },
    );

    expect(response.status).toBe(204);
    expect(calls.some(({ sql }) =>
      sql.includes("update run_steering_attempts") && sql.includes("STEER_FALLBACK_ABANDONED"),
    )).toBe(true);
    expect(calls.some(({ sql }) =>
      sql.includes("Follow-up incertain abandonné") && sql.includes("status = 'queued'"),
    )).toBe(true);
  });

  test("allows an owner to dismiss a failed workflow from the inbox", async () => {
    const calls: SqlCall[] = [];
    const response = await mount(recoveryDb(calls, { status: "failed" })).request(
      "/workflow-1/abandon",
      { method: "POST" },
    );

    expect(response.status).toBe(204);
    expect(calls.some(({ sql }) =>
      sql.includes("recovery_state = recovery_state ||") && sql.includes("status in ('failed', 'expired')"),
    )).toBe(true);
    expect(calls.some(({ values }) =>
      values.some((value) =>
        value && typeof value === "object" && (value as Record<string, unknown>).resolution === "abandoned"
          && (value as Record<string, unknown>).duplicateRisk === false),
    )).toBe(true);
    expect(calls.some(({ sql }) =>
      sql.includes("update workflows set status = 'failed'") && sql.includes("EXTERNAL_OUTCOME_ABANDONED"),
    )).toBe(false);
  });

  test("abandon already resolved is a no-op", async () => {
    const calls: SqlCall[] = [];
    const response = await mount(recoveryDb(calls, {
      status: "failed",
      recoveryState: { resolution: "abandoned" },
    })).request("/workflow-1/abandon", { method: "POST" });

    expect(response.status).toBe(204);
    expect(calls.some(({ sql }) => sql.includes("update workflows"))).toBe(false);
    expect(calls.some(({ sql }) => sql.includes("update runs"))).toBe(false);
  });

  test("refuses abandonment before touching the database for a member", async () => {
    const calls: SqlCall[] = [];
    const response = await mount(recoveryDb(calls), { ...owner, role: "member" }).request(
      "/workflow-1/abandon",
      { method: "POST" },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "ROLE_REQUIRED" } });
    expect(calls).toHaveLength(0);
  });

  test("requires the exact confirmDuplicateRisk=true acknowledgement before retry", async () => {
    for (const body of [{}, { confirmDuplicateRisk: false }, { confirmDuplicateRisk: "true" }]) {
      const calls: SqlCall[] = [];
      const response = await mount(recoveryDb(calls)).request("/workflow-1/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "DUPLICATE_RISK_CONFIRMATION_REQUIRED" } });
      expect(calls).toHaveLength(0);
    }
  });


  test("passes the confirmation gate only for confirmDuplicateRisk=true", async () => {
    const calls: SqlCall[] = [];
    const response = await mount(recoveryDb(calls)).request("/workflow-1/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmDuplicateRisk: true }),
    });

    // The fake deliberately has no root run: reaching this domain error proves
    // the exact acknowledgement passed the duplicate-risk gate and entered the transaction.
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "WORKFLOW_ROOT_MISSING" } });
    expect(calls.some(({ sql }) => sql.includes("from workflows") && sql.includes("for update"))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("from runs") && sql.includes("limit 1 for update"))).toBe(true);
  });

  test("returns THREAD_BUSY after checking that the old workflow has no retry receipt", async () => {
    const calls: SqlCall[] = [];
    const response = await mount(recoveryDb(calls, { busy: true })).request("/workflow-1/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmDuplicateRisk: true }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "THREAD_BUSY" } });
    const threadLock = calls.findIndex(({ sql }) => sql.includes("from threads") && sql.includes("for update"));
    const workflowLock = calls.findIndex(({ sql }) => sql.includes("from workflows") && sql.includes("for update"));
    const busyCheck = calls.findIndex(({ sql }) => sql.includes("workflow_id is distinct from"));
    expect(threadLock).toBeGreaterThanOrEqual(0);
    expect(threadLock).toBeLessThan(workflowLock);
    expect(workflowLock).toBeLessThan(busyCheck);
    expect(calls.some(({ sql }) => sql.includes("insert into workflows"))).toBe(false);
  });

  test("réactive sur place le repli ambigu, sans perdre son rang FIFO", async () => {
    const calls: SqlCall[] = [];
    const response = await mount(recoveryDb(calls, { ambiguousSteer: true })).request(
      "/workflow-1/retry",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmDuplicateRisk: true }),
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      workflowId: "workflow-1",
      runId: "run-1",
      status: "queued",
      duplicateRisk: true,
    });
    expect(calls.some(({ sql }) =>
      sql.includes("update run_steering_attempts") && sql.includes("STEER_FALLBACK_CONFIRMED"),
    )).toBe(true);
    expect(calls.some(({ sql }) =>
      sql.includes("update workflows set status = 'queued'") && sql.includes("deadline_at = now()"),
    )).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("insert into workflows"))).toBe(false);
    expect(calls.some(({ sql }) => sql.includes("workflow_id is distinct from"))).toBe(false);
  });

  test("réactive le repli ambigu avec un recovery_state objet, jamais NULL", async () => {
    const calls: SqlCall[] = [];
    const response = await mount(recoveryDb(calls, { ambiguousSteer: true })).request(
      "/workflow-1/retry",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmDuplicateRisk: true }),
      },
    );

    expect(response.status).toBe(202);
    const requeue = calls.find(({ sql }) => sql.includes("update workflows set status = 'queued'"));
    // 0005 : `recovery_state jsonb not null check (jsonb_typeof = 'object')`.
    expect(requeue?.sql).toContain("recovery_state = '{}'::jsonb");
    expect(requeue?.sql).not.toContain("recovery_state = null");
  });

  test("la relance garde le plan, la routine sans attente et le message source du tour d'origine", async () => {
    const calls: SqlCall[] = [];
    const response = await mount(idempotentRetryDb(calls, {
      planOnly: true,
      neverWait: true,
      sourceMessageId: "message-1",
    })).request("/workflow-1/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmDuplicateRisk: true }),
    });

    expect(response.status).toBe(202);
    const rootRead = calls.find(({ sql }) => sql.includes('bot_id as "botId"'));
    expect(rootRead?.sql).toContain("(run.plan_only or source.plan_only)");
    expect(rootRead?.sql).toContain("source.never_wait");
    expect(rootRead?.sql).toContain("coalesce(run.source_message_id,");
    const workflow = inserted(calls, "workflows");
    expect([workflow.plan_only, workflow.never_wait]).toEqual([true, true]);
    const run = inserted(calls, "runs");
    expect([run.plan_only, run.source_message_id]).toEqual([true, "message-1"]);
  });

  test("une relance ordinaire n'invente aucune restriction", async () => {
    const calls: SqlCall[] = [];
    const response = await mount(idempotentRetryDb(calls)).request("/workflow-1/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmDuplicateRisk: true }),
    });

    expect(response.status).toBe(202);
    const workflow = inserted(calls, "workflows");
    expect([workflow.plan_only, workflow.never_wait]).toEqual([false, false]);
    const run = inserted(calls, "runs");
    expect([run.plan_only, run.source_message_id]).toEqual([false, null]);
  });

  test("0175 : la revue d'un brouillon de persona ou d'un hand-off hérité s'abandonne, sans relance", async () => {
    for (const [options, code] of [
      [{ stepKind: "persona_draft" }, "WORKFLOW_SERVICE_RETRY_UNSUPPORTED"],
      [{ stepKind: null, originRunId: "courier-1" }, "WORKFLOW_HANDOFF_RETRY_UNSUPPORTED"],
    ] as const) {
      const calls: SqlCall[] = [];
      const response = await mount(idempotentRetryDb(calls, options)).request("/workflow-1/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmDuplicateRisk: true }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code } });
      expect(calls.some(({ sql }) => sql.includes("insert into") || sql.includes("update runs"))).toBe(false);
    }
  });

  test("refuse la relance si le run de repli ambigu a disparu", async () => {
    const calls: SqlCall[] = [];
    const response = await mount(recoveryDb(calls, {
      ambiguousSteer: true,
      fallbackMissing: true,
    })).request("/workflow-1/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmDuplicateRisk: true }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "STEER_FALLBACK_MISSING" } });
    expect(calls.some(({ sql }) => sql.includes("update workflows set status = 'queued'"))).toBe(false);
  });

  test("replays the first replacement receipt and never creates a second workflow", async () => {
    const calls: SqlCall[] = [];
    const db = idempotentRetryDb(calls);
    const app = mount(db);
    const request = () => app.request("/workflow-1/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmDuplicateRisk: true }),
    });

    const first = await request();
    const firstBody = await first.json();
    const second = await request();

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(firstBody);
    expect(firstBody).toEqual({
      workflowId: expect.any(String),
      runId: expect.any(String),
      status: "queued",
      duplicateRisk: true,
    });
    expect(calls.filter(({ sql }) => sql.includes("insert into workflows"))).toHaveLength(1);
    expect(calls.filter(({ sql }) => sql.includes("insert into runs"))).toHaveLength(1);
    expect(inserted(calls, "workflows").autonomy_enabled).toBe(false);
  });

  test("fails safely when a historical retry marker has no replayable receipt", async () => {
    const calls: SqlCall[] = [];
    const response = await mount(recoveryDb(calls, {
      recoveryState: { resolution: "retried", duplicateRisk: true },
    })).request("/workflow-1/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmDuplicateRisk: true }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "WORKFLOW_RETRY_ALREADY_CONSUMED" } });
    expect(calls.some(({ sql }) => sql.includes("workflow_id is distinct from"))).toBe(false);
    expect(calls.some(({ sql }) => sql.includes("insert into workflows"))).toBe(false);
  });
});

type SqlCall = { sql: string; values: unknown[] };

function inserted(calls: SqlCall[], table: "runs" | "workflows"): Record<string, unknown> {
  const call = calls.find(({ sql }) => sql.includes(`insert into ${table}`));
  if (!call) throw new Error(`no insert into ${table}`);
  return insertedRow(call.sql, call.values);
}

function mount(
  db: SQL,
  auth: AuthContext = owner,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED" } }, 500));
  app.route("/", workflowRoutes(db));
  return app;
}

function recoveryDb(
  calls: SqlCall[],
  options: {
    hermesRunId?: string | null;
    busy?: boolean;
    recoveryState?: unknown;
    status?: string;
    ambiguousSteer?: boolean;
    fallbackMissing?: boolean;
  } = {},
): SQL {
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    calls.push({ sql, values });
    if (sql.includes('select thread_id as "threadId" from workflows')) {
      return Promise.resolve([{ threadId: "thread-1" }]);
    }
    if (sql.includes("select id from threads")) {
      return Promise.resolve([{ id: "thread-1" }]);
    }
    if (sql.includes("workflow_id is distinct from")) {
      return Promise.resolve(options.busy ? [{ id: "other-run" }] : []);
    }
    if (sql.includes("from run_steering_attempts steer")) {
      return Promise.resolve(options.ambiguousSteer ? [{ id: "steer-1", sourceRunId: "run-1" }] : []);
    }
    if (options.ambiguousSteer && sql.includes("update runs set status = 'queued'")) {
      return Promise.resolve(options.fallbackMissing ? [] : [{ id: "run-1" }]);
    }
    if (sql.includes("from workflows") && sql.includes("for update")) {
      return Promise.resolve([{
        ...workflowRow(),
        status: options.status ?? "unknown",
        recoveryState: options.recoveryState ?? {},
      }]);
    }
    if (sql.includes("select id, hermes_run_id")) {
      return Promise.resolve([{ id: "run-1", hermesRunId: options.hermesRunId ?? null }]);
    }
    if (sql.includes("insert into run_events")) {
      return Promise.resolve([{ cursor: "1", botId: null, turnId: null, sessionKey: null, leaseGeneration: "0", occurredAt: new Date() }]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

function idempotentRetryDb(
  calls: SqlCall[],
  options: {
    planOnly?: boolean; neverWait?: boolean; sourceMessageId?: string | null;
    stepKind?: string | null; originRunId?: string | null;
  } = {},
): SQL {
  let recoveryState: Record<string, unknown> = {};
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    calls.push({ sql, values });
    if (sql.includes('select thread_id as "threadId" from workflows')) {
      return Promise.resolve([{ threadId: "thread-1" }]);
    }
    if (sql.includes("select id from threads")) {
      return Promise.resolve([{ id: "thread-1" }]);
    }
    if (sql.includes("from workflows") && sql.includes("for update")) {
      return Promise.resolve([{ ...workflowRow(), status: recoveryState.resolution === "retried" ? "failed" : "unknown", recoveryState }]);
    }
    if (sql.includes("workflow_id is distinct from")) return Promise.resolve([]);
    if (sql.includes('bot_id as "botId"')) {
      return Promise.resolve([{
        botId: "bot-1",
        input: "Retry this",
        model: null,
        stepKind: options.stepKind === undefined ? "root" : options.stepKind,
        stackDepth: 0,
        callerBotId: null,
        groupTurnPosition: null,
        groupState: null,
        planOnly: options.planOnly ?? false,
        neverWait: options.neverWait ?? false,
        sourceMessageId: options.sourceMessageId ?? null,
        originRunId: options.originRunId ?? null,
      }]);
    }
    if (sql.includes("select id from bots")) return Promise.resolve([{ id: "bot-1" }]);
    if (sql.includes("update workflows set status = 'failed'") && sql.includes("recovery_state")) {
      const receipt = values.find((value) =>
        value && typeof value === "object" && (value as Record<string, unknown>).resolution === "retried");
      if (receipt) recoveryState = receipt as Record<string, unknown>;
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

function workflowRow() {
  const now = new Date("2026-08-25T12:00:00.000Z");
  return {
    id: "workflow-1",
    threadId: "thread-1",
    rootRunId: "run-1",
    rootBotId: "bot-1",
    initiatorUserId: "user-1",
    kind: "dm",
    status: "unknown",
    protocolVersion: 1,
    autonomyEnabled: false,
    maxDepth: 3,
    maxSteps: 8,
    maxHandoffs: 4,
    timeoutSeconds: 1_800,
    tokenBudget: 50_000,
    usedSteps: 1,
    usedHandoffs: 0,
    usedTokens: 0,
    deadlineAt: now,
    errorCode: "HERMES_CREATE_AMBIGUOUS",
    errorMessage: "unknown",
    recoveryState: {},
    createdAt: now,
    updatedAt: now,
  };
}

function workflowDtoDb(
  calls: SqlCall[],
  options: { kind: string; status: string; recoveryState: unknown },
): SQL {
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    calls.push({ sql, values });
    if (sql.includes("from workflows") && sql.includes('recovery_state as "recoveryState"')) {
      return Promise.resolve([{
        ...workflowRow(),
        kind: options.kind,
        status: options.status,
        recoveryState: options.recoveryState,
        errorCode: null,
        errorMessage: null,
      }]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

function workflowHistoryDb(
  calls: SqlCall[],
  options: { kind: string; status: string; recoveryState: unknown },
): SQL {
  const now = new Date("2026-08-25T12:00:00.000Z");
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    calls.push({ sql, values });
    if (sql.includes("from workflows w")) {
      return Promise.resolve([{
        id: "workflow-1",
        threadId: "thread-1",
        kind: options.kind,
        status: options.status,
        usedSteps: 1,
        maxSteps: 8,
        usedHandoffs: 0,
        maxHandoffs: 4,
        usedTokens: 0,
        tokenBudget: 50_000,
        errorCode: null,
        errorMessage: null,
        finalOutput: null,
        recoveryState: options.recoveryState,
        createdAt: now,
        startedAt: now,
        endedAt: now,
        botName: "Scout",
        botSlug: "scout",
        botFace: null,
        groupId: null,
        groupName: null,
        initiatorName: "Ada",
        initiatorEmail: "ada@example.com",
      }]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

describe("history query parameters", () => {
  // Un paramètre d'URL vient d'un lien collé, d'un signet, ou d'une page
  // précédente : il ne doit jamais produire d'erreur devant l'opérateur, ni
  // laisser passer une valeur qui atteindrait SQL.
  test("an unknown or missing filter falls back to the full view", () => {
    expect(readHistoryFilter("active")).toBe("active");
    expect(readHistoryFilter("attention")).toBe("attention");
    expect(readHistoryFilter(null)).toBe("all");
    expect(readHistoryFilter("' or 1=1 --")).toBe("all");
  });

  test("the page size stays between one and the hard ceiling", () => {
    expect(readHistoryLimit(null)).toBe(25);
    expect(readHistoryLimit("10")).toBe(10);
    expect(readHistoryLimit("0")).toBe(25);
    expect(readHistoryLimit("-5")).toBe(25);
    expect(readHistoryLimit("2.5")).toBe(25);
    expect(readHistoryLimit("100000")).toBe(100);
  });

  test("a cursor is read only when both halves are well formed", () => {
    expect(readHistoryCursor("2026-08-25T21:55:29.286Z|ce429726-2526-4fe6-b2a9-3718b05d5b1a")).toEqual({
      createdAt: "2026-08-25T21:55:29.286Z",
      id: "ce429726-2526-4fe6-b2a9-3718b05d5b1a",
    });
    for (const malformed of [
      null,
      "",
      "|",
      "pas-une-date|ce429726-2526-4fe6-b2a9-3718b05d5b1a",
      "2026-08-25T21:55:29.286Z|pas-un-uuid",
      "2026-08-25T21:55:29.286Z",
      "|ce429726-2526-4fe6-b2a9-3718b05d5b1a",
    ]) {
      expect(readHistoryCursor(malformed)).toBeNull();
    }
  });
});
