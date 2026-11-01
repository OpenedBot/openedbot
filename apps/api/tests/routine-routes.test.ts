import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import {
  canonicalRoutineRunHash,
  groupRoutineRoutes,
  lockRoutineQuota,
  publicRoutine,
  readRoutineReceiptCursor,
  readRoutineReceiptStatus,
  routineRoutes,
  validatedRoutineInput,
} from "../src/routes/execution/routine-routes";
import { tableSubscriptionPort } from "./fixtures/table-subscription-port";
import { installSubscriptionPort } from "@openedbot/platform-db/subscription-port";

// The subscription reads go through the port, as the API installs it.
beforeAll(() => installSubscriptionPort(tableSubscriptionPort));
afterAll(() => installSubscriptionPort(null));

describe("validation d'une routine", () => {
  test("entrée complète : normalisée telle quelle", () => {
    expect(
      validatedRoutineInput({
        name: "  Revue matinale ",
        schedule: "0 9 * * 1-5",
        timezone: "Europe/Paris",
        message: "Fais le point sur la nuit.",
      }),
    ).toEqual({
      name: "Revue matinale",
      schedule: "0 9 * * 1-5",
      timezone: "Europe/Paris",
      message: "Fais le point sur la nuit.",
      enabled: true,
      neverWait: false,
    });
  });

  test("PERM2-9 : « Ne jamais attendre » est faux par défaut, un non-booléen est un 400", () => {
    const base = { name: "r", schedule: "0 * * * *", message: "m" };
    expect(validatedRoutineInput(base).neverWait).toBe(false);
    expect(validatedRoutineInput({ ...base, neverWait: true }).neverWait).toBe(true);
    expect(validatedRoutineInput({ ...base, neverWait: false }).neverWait).toBe(false);
    for (const value of ["true", 1, null, {}]) {
      let caught: unknown = null;
      try { validatedRoutineInput({ ...base, neverWait: value }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(HttpError);
      expect((caught as HttpError).status).toBe(400);
      expect((caught as HttpError).code).toBe("ROUTINE_NEVER_WAIT_INVALID");
    }
  });

  test("fuseau absent ou vide : UTC", () => {
    expect(validatedRoutineInput({ name: "r", schedule: "0 * * * *", message: "m" }).timezone).toBe("UTC");
    expect(validatedRoutineInput({ name: "r", schedule: "0 * * * *", timezone: "  ", message: "m" }).timezone).toBe("UTC");
  });

  test("un cron invalide est un 400 ROUTINE_SCHEDULE_INVALID", () => {
    try {
      validatedRoutineInput({ name: "r", schedule: "tous les jours", message: "m" });
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).code).toBe("ROUTINE_SCHEDULE_INVALID");
    }
  });

  test("un cron valide mais impossible est refusé lorsqu'il est activé", () => {
    try {
      validatedRoutineInput({ name: "r", schedule: "0 0 31 2 *", message: "m" });
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).code).toBe("ROUTINE_SCHEDULE_NO_OCCURRENCE");
    }
    expect(validatedRoutineInput({
      name: "r",
      schedule: "0 0 31 2 *",
      message: "m",
      enabled: false,
    }).enabled).toBe(false);
  });

  test("un fuseau invalide est un 400 ROUTINE_TIMEZONE_INVALID", () => {
    try {
      validatedRoutineInput({ name: "r", schedule: "0 * * * *", timezone: "Mars/Olympus", message: "m" });
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe("ROUTINE_TIMEZONE_INVALID");
    }
  });

  test("nom et message restent obligatoires", () => {
    expect(() => validatedRoutineInput({ schedule: "0 * * * *", message: "m" })).toThrow(HttpError);
    expect(() => validatedRoutineInput({ name: "r", schedule: "0 * * * *" })).toThrow(HttpError);
  });

  test("`enabled` non booléen retombe sur true", () => {
    expect(validatedRoutineInput({ name: "r", schedule: "0 * * * *", message: "m", enabled: "no" }).enabled).toBe(true);
    expect(validatedRoutineInput({ name: "r", schedule: "0 * * * *", message: "m", enabled: false }).enabled).toBe(false);
  });
});

describe("projection publique d'une routine", () => {
  test("expose missedCount et lastMissedAt en ISO", () => {
    expect(publicRoutine({
      id: "routine-1",
      botId: "bot-1",
      groupId: null,
      name: "Revue",
      schedule: "0 * * * *",
      timezone: "UTC",
      message: "m",
      enabled: true,
      nextRunAt: new Date("2026-01-01T16:00:00.000Z"),
      lastRunAt: new Date("2026-01-01T15:00:00.000Z"),
      missedCount: "6",
      lastMissedAt: new Date("2026-01-01T15:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T15:00:00.000Z"),
      neverWait: true,
    })).toMatchObject({
      neverWait: true,
      missedCount: 6,
      lastMissedAt: "2026-01-01T15:00:00.000Z",
      nextRunAt: "2026-01-01T16:00:00.000Z",
    });
  });
});

describe("quota de routines", () => {
  test("prend un verrou transactionnel PostgreSQL propre au tenant et au bot avant le count", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?"), values });
      return Promise.resolve([]);
    }) as unknown as Bun.TransactionSQL;

    await lockRoutineQuota(tx, "tenant-1", "bot-1");

    expect(calls).toEqual([{
      sql: "select pg_advisory_xact_lock(hashtext(?), hashtext(?))",
      values: ["tenant-1", "bot-1"],
    }]);
  });
});

const owner: AuthContext = {
  sessionId: "session-1",
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "user-1",
  role: "owner",
  kind: "web",
  credentialHash: "credential",
};

const ROUTINE_ID = "00000000-0000-4000-8000-000000000010";
const WORKFLOW_1 = "00000000-0000-4000-8000-000000000020";
const WORKFLOW_2 = "00000000-0000-4000-8000-000000000021";
const RUN_KEY = "00000000-0000-4000-8000-000000000030";

describe("lancement manuel durable d'une routine", () => {
  test("matérialise immédiatement un workflow détaché sans déplacer le cron", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const response = await mount(routineRunDb(calls)).request(`/${ROUTINE_ID}/runs`, {
      method: "POST",
      headers: { "Idempotency-Key": RUN_KEY },
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      accepted: true,
      duplicate: false,
      routineId: ROUTINE_ID,
      threadId: "00000000-0000-4000-8000-000000000040",
      status: "queued",
      notificationEligible: true,
    });
    expect(body.workflowId).toBeString();
    expect(body.runId).toBeString();

    const routineRead = calls.find((call) => call.sql.includes("from routines r"));
    expect(routineRead?.sql).toContain("r.organization_id =");
    expect(routineRead?.sql).toContain("for update of r, thread");
    expect(routineRead?.values).toContain(owner.organizationId);
    expect(routineRead?.values).toContain(ROUTINE_ID);

    const ingressInsert = calls.find((call) => call.sql.includes("insert into message_ingress"));
    expect(ingressInsert?.sql).toContain("'routine.run.create'");
    expect(ingressInsert?.values).toContain(RUN_KEY);
    expect(ingressInsert?.values).toContain(canonicalRoutineRunHash(ROUTINE_ID));

    const workflowInsert = calls.find((call) => call.sql.includes("insert into workflows"));
    expect(workflowInsert?.sql).toContain("kind, status");
    expect(workflowInsert?.values).toContain("routine");
    expect(workflowInsert?.values).toContain(owner.userId);
    expect(workflowInsert?.values).toContainEqual({ routineId: ROUTINE_ID, trigger: "manual" });

    const runInsert = calls.find((call) => call.sql.includes("insert into runs"));
    expect(runInsert?.sql).toContain("'not_started'");
    expect(runInsert?.values).toContain("root");
    expect(calls.some((call) => call.sql.includes("insert into routine_executions"))).toBe(true);
    const messageInsert = calls.find((call) => call.sql.includes("insert into messages"));
    expect(messageInsert?.values).toContainEqual([{
      type: "text",
      text: "[Routine « Revue quotidienne »] Fais le point.",
    }]);

    const routineUpdate = calls.find((call) => call.sql.includes("update routines set last_run_at"));
    expect(routineUpdate?.sql).not.toContain("next_run_at");
    const receiptUpdate = calls.find((call) => call.sql.includes("update message_ingress set state = 'completed'"));
    expect(receiptUpdate?.values).toContainEqual(expect.objectContaining({
      workflowId: body.workflowId,
      runId: body.runId,
      routineId: ROUTINE_ID,
    }));
  });

  test("rejoue le même accusé avant même de relire une routine supprimée", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const stored = acceptedRoutineRun();
    const response = await mount(routineRunDb(calls, { replay: stored })).request(`/${ROUTINE_ID}/runs`, {
      method: "POST",
      headers: { "Idempotency-Key": RUN_KEY },
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual({ ...stored, duplicate: true });
    expect(calls.some((call) => call.sql.includes("from routines r"))).toBe(false);
    expect(calls.some((call) => call.sql.includes("insert into workflows"))).toBe(false);
  });

  test("refuse la même clé pour une autre routine sans effet de bord", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const other = "00000000-0000-4000-8000-000000000011";
    const response = await mount(routineRunDb(calls, { replay: acceptedRoutineRun() }))
      .request(`/${other}/runs`, { method: "POST", headers: { "Idempotency-Key": RUN_KEY } });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    expect(calls.some((call) => call.sql.includes("insert into workflows"))).toBe(false);
  });

  test("refuse un fil occupé et laisse la même clé disponible pour une reprise", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const response = await mount(routineRunDb(calls, { busy: true })).request(`/${ROUTINE_ID}/runs`, {
      method: "POST",
      headers: { "Idempotency-Key": RUN_KEY },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "THREAD_BUSY" } });
    expect(calls.findIndex((call) => call.sql.includes("insert into message_ingress")))
      .toBeLessThan(calls.findIndex((call) => call.sql.includes("select id from runs")));
    expect(calls.some((call) => call.sql.includes("insert into workflows"))).toBe(false);
  });

  test("applique l'abonnement et valide les identifiants avant le SQL", async () => {
    const billedCalls: Array<{ sql: string; values: unknown[] }> = [];
    const inactive = await mount(routineRunDb(billedCalls, { subscriptionStatus: "canceled" }), true)
      .request(`/${ROUTINE_ID}/runs`, { method: "POST", headers: { "Idempotency-Key": RUN_KEY } });
    expect(inactive.status).toBe(403);
    expect(await inactive.json()).toEqual({ error: { code: "SUBSCRIPTION_INACTIVE" } });
    expect(billedCalls.some((call) => call.sql.includes("insert into workflows"))).toBe(false);

    const noKeyCalls: Array<{ sql: string; values: unknown[] }> = [];
    const noKey = await mount(routineRunDb(noKeyCalls)).request(`/${ROUTINE_ID}/runs`, { method: "POST" });
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toEqual({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    expect(noKeyCalls).toHaveLength(0);

    const invalidCalls: Array<{ sql: string; values: unknown[] }> = [];
    const invalid = await mount(routineRunDb(invalidCalls)).request("/not-a-uuid/runs", {
      method: "POST",
      headers: { "Idempotency-Key": RUN_KEY },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: { code: "ROUTINE_ID_INVALID" } });
    expect(invalidCalls).toHaveLength(0);
  });

  test("un identifiant absent ou d'un autre tenant reste un 404", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const response = await mount(routineRunDb(calls, { missingRoutine: true })).request(`/${ROUTINE_ID}/runs`, {
      method: "POST",
      headers: { "Idempotency-Key": RUN_KEY },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "ROUTINE_NOT_FOUND" } });
    expect(calls.some((call) => call.sql.includes("insert into message_ingress"))).toBe(false);
  });
});

describe("reçus d'exécution des routines", () => {
  test("retourne une page filtrée et un curseur stable", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = receiptDb(calls, [
      receiptRow(WORKFLOW_1, "2026-08-26T10:00:00.000Z"),
      receiptRow(WORKFLOW_2, "2026-08-25T10:00:00.000Z"),
    ]);
    const response = await mount(db).request(
      `/receipts?routineId=${ROUTINE_ID}&status=completed&limit=1`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      receipts: [{
        routineId: ROUTINE_ID,
        workflowId: WORKFLOW_1,
        runId: "run-1",
        threadId: "thread-1",
        botId: "bot-1",
        status: "completed",
        trigger: null,
        errorCode: null,
        errorMessage: null,
        createdAt: "2026-08-26T10:00:00.000Z",
        startedAt: "2026-08-26T10:00:01.000Z",
        endedAt: "2026-08-26T10:00:03.000Z",
        durationMs: 2_000,
      }],
      nextCursor: `2026-08-26T10:00:00.000Z|${WORKFLOW_1}`,
    });
    const query = calls.find((call) => call.sql.includes("from workflows w"));
    expect(query?.sql).toContain("w.kind = 'routine'");
    expect(query?.sql).toContain("w.recovery_state->>'routineId'");
    expect(query?.sql).toContain("w.recovery_state->>'trigger'");
    expect(query?.sql).toContain("having count(*) = 1");
    expect(query?.sql).toContain('order by "createdAt" desc, "workflowId" desc');
    expect(query?.values).toContain(ROUTINE_ID);
    expect(query?.values).toContain("completed");
  });

  test("refuse statut et curseur inconnus avant toute lecture SQL", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const app = mount(receiptDb(calls, []));
    const invalidStatus = await app.request("/receipts?status=done");
    const invalidCursor = await app.request("/receipts?cursor=not-a-cursor");

    expect(invalidStatus.status).toBe(400);
    expect(await invalidStatus.json()).toEqual({ error: { code: "ROUTINE_RECEIPT_STATUS_INVALID" } });
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toEqual({ error: { code: "ROUTINE_RECEIPT_CURSOR_INVALID" } });
    expect(calls).toHaveLength(0);
  });

  test("expose trigger depuis recovery_state sans le reste de l'objet", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const response = await mount(receiptDb(calls, [
      receiptRow(WORKFLOW_1, "2026-08-26T10:00:00.000Z", "manual"),
    ])).request("/receipts");

    expect(response.status).toBe(200);
    const body = await response.json() as { receipts: Array<{ trigger: string | null }> };
    expect(body.receipts[0]?.trigger).toBe("manual");
  });

  test("le parseur de curseur canonicalise ISO et UUID, sans repli permissif", () => {
    expect(readRoutineReceiptStatus("unknown")).toBe("unknown");
    expect(
      readRoutineReceiptCursor(`2026-08-26T12:00:00+02:00|${WORKFLOW_1.toUpperCase()}`),
    ).toEqual({ createdAt: "2026-08-26T10:00:00.000Z", id: WORKFLOW_1 });
    expect(() => readRoutineReceiptCursor("2026-08-26|bad")).toThrow(HttpError);
  });
});

const GROUP_ID = "00000000-0000-4000-8000-000000000070";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000080";

describe("GET /api/routines/:id/executions", () => {
  test("page un historique d'issues, curseur inclus", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = executionDb(calls, [{
      id: EXECUTION_ID,
      routineId: ROUTINE_ID,
      outcome: "abandoned",
      trigger: "scheduled",
      missedCount: 1,
      busyRetries: 10,
      errorCode: "ROUTINE_BUSY_RETRIES_EXHAUSTED",
      errorMessage: "Fil occupé : 10 reports de 60 s épuisés, occurrence abandonnée.",
      workflowId: null,
      runId: null,
      threadId: "thread-1",
      workflowStatus: null,
      createdAt: new Date("2026-08-26T10:00:00.000Z"),
    }]);
    const response = await mount(db).request(`/${ROUTINE_ID}/executions?limit=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      executions: [{
        id: EXECUTION_ID,
        routineId: ROUTINE_ID,
        outcome: "abandoned",
        trigger: "scheduled",
        missedCount: 1,
        busyRetries: 10,
        errorCode: "ROUTINE_BUSY_RETRIES_EXHAUSTED",
        errorMessage: "Fil occupé : 10 reports de 60 s épuisés, occurrence abandonnée.",
        workflowId: null,
        runId: null,
        threadId: "thread-1",
        workflowStatus: null,
        createdAt: "2026-08-26T10:00:00.000Z",
      }],
      nextCursor: null,
    });
    expect(calls.some((call) => call.sql.includes("from routine_executions"))).toBe(true);
  });

  test("404 si la routine n'existe pas", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const response = await mount(executionDb(calls, [], { missingRoutine: true }))
      .request(`/${ROUTINE_ID}/executions`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "ROUTINE_NOT_FOUND" } });
  });
});

describe("routines de salon", () => {
  test("POST crée une routine groupId xor botId", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const app = mountGroup(groupCreateDb(calls));
    const response = await app.request(`/${GROUP_ID}/routines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Stand-up", schedule: "0 9 * * 1-5", message: "Tour de table." }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { botId: string | null; groupId: string | null };
    expect(body.botId).toBeNull();
    expect(body.groupId).toBe(GROUP_ID);
    const insert = calls.find((call) => call.sql.includes("insert into routines"));
    expect(insert?.sql).toContain("bot_id, group_id");
    expect(insert?.values).toContain(null);
    expect(insert?.values).toContain(GROUP_ID);
  });
});

function mount(db: SQL, billingEnforced = false): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", owner);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED" } }, 500));
  app.route("/", routineRoutes(db, billingEnforced));
  return app;
}

function mountGroup(db: SQL): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", owner);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED" } }, 500));
  app.route("/", groupRoutineRoutes(db));
  return app;
}

function executionDb(
  calls: Array<{ sql: string; values: unknown[] }>,
  rows: Array<Record<string, unknown>>,
  options: { missingRoutine?: boolean } = {},
): SQL {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    calls.push({ sql, values });
    if (sql.includes("select set_config")) return Promise.resolve([]);
    if (sql.includes("select id from routines")) {
      return Promise.resolve(options.missingRoutine ? [] : [{ id: ROUTINE_ID }]);
    }
    if (sql.includes("from routine_executions")) return Promise.resolve(rows);
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tag as unknown as { begin: (callback: (tx: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback) => callback(tag);
  return tag;
}

function groupCreateDb(calls: Array<{ sql: string; values: unknown[] }>): SQL {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    calls.push({ sql, values });
    if (sql.includes("select set_config")) return Promise.resolve([]);
    if (sql.includes("from bot_groups")) return Promise.resolve([{ id: GROUP_ID }]);
    if (sql.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
    if (sql.includes("select count(*)")) return Promise.resolve([{ count: 0 }]);
    if (sql.includes("insert into routines")) {
      return Promise.resolve([{
        id: ROUTINE_ID,
        botId: null,
        groupId: GROUP_ID,
        name: "Stand-up",
        schedule: "0 9 * * 1-5",
        timezone: "UTC",
        message: "Tour de table.",
        enabled: true,
        nextRunAt: new Date("2026-01-05T09:00:00.000Z"),
        lastRunAt: null,
        missedCount: 0,
        lastMissedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tag as unknown as { begin: (callback: (tx: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback) => callback(tag);
  return tag;
}

function acceptedRoutineRun() {
  return {
    accepted: true as const,
    duplicate: false,
    routineId: ROUTINE_ID,
    workflowId: WORKFLOW_1,
    runId: "00000000-0000-4000-8000-000000000050",
    threadId: "00000000-0000-4000-8000-000000000040",
    status: "queued" as const,
    notificationEligible: true,
    workflowUpdatedAt: "2026-08-26T12:00:00.000Z",
  };
}

function routineRunDb(
  calls: Array<{ sql: string; values: unknown[] }>,
  options: {
    replay?: ReturnType<typeof acceptedRoutineRun>;
    busy?: boolean;
    missingRoutine?: boolean;
    subscriptionStatus?: string;
  } = {},
): SQL {
  let reserved = false;
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    calls.push({ sql, values });
    if (sql.includes("select set_config")) return Promise.resolve([]);
    if (sql.includes("from message_ingress")) {
      if (options.replay) {
        return Promise.resolve([{
          id: "ingress-1",
          requestHash: canonicalRoutineRunHash(options.replay.routineId),
          state: "completed",
          messageId: "message-1",
          runId: options.replay.runId,
          workflowId: options.replay.workflowId,
          responseStatus: 202,
          responseBody: options.replay,
        }]);
      }
      return Promise.resolve(reserved ? [{
        id: "ingress-1",
        requestHash: canonicalRoutineRunHash(ROUTINE_ID),
        state: "reserved",
        messageId: "message-1",
        runId: "run-1",
        workflowId: "workflow-1",
        responseStatus: null,
        responseBody: null,
      }] : []);
    }
    if (sql.includes("from routines r")) return Promise.resolve(options.missingRoutine ? [] : [{
      id: ROUTINE_ID,
      botId: "00000000-0000-4000-8000-000000000060",
      groupId: null,
      threadId: "00000000-0000-4000-8000-000000000040",
      groupDefaultResponder: { kind: "everyone" },
      name: "Revue quotidienne",
      message: "Fais le point.",
      autonomyEnabled: false,
      autonomyMaxDepth: 3,
      autonomyMaxSteps: 8,
      autonomyMaxHandoffs: 4,
      autonomyTimeoutSeconds: 1_800,
      autonomyTokenBudget: "50000",
    }]);
    if (sql.includes("insert into message_ingress")) {
      reserved = true;
      return Promise.resolve([{ id: "ingress-1" }]);
    }
    if (sql.includes("from subscriptions")) {
      return Promise.resolve(options.subscriptionStatus ? [{ status: options.subscriptionStatus }] : []);
    }
    if (sql.includes("select id from runs")) return Promise.resolve(options.busy ? [{ id: "run-active" }] : []);
    if (sql.includes("update message_ingress set state = 'completed'")) return Promise.resolve([{ id: "ingress-1" }]);
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tag as unknown as { begin: (callback: (tx: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback) => callback(tag);
  return tag;
}

function receiptDb(
  calls: Array<{ sql: string; values: unknown[] }>,
  rows: Array<Record<string, unknown>>,
): SQL {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    calls.push({ sql, values });
    if (sql.includes("select set_config")) return Promise.resolve([]);
    if (sql.includes("from workflows w")) return Promise.resolve(rows);
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tag as unknown as { begin: (callback: (tx: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback) => callback(tag);
  return tag;
}

function receiptRow(workflowId: string, createdAt: string, trigger: "manual" | "scheduled" | null = null): Record<string, unknown> {
  return {
    routineId: ROUTINE_ID,
    workflowId,
    runId: "run-1",
    threadId: "thread-1",
    botId: "bot-1",
    status: "completed",
    trigger,
    errorCode: null,
    errorMessage: null,
    createdAt,
    startedAt: "2026-08-26T10:00:01.000Z",
    endedAt: "2026-08-26T10:00:03.000Z",
  };
}
