import { describe, expect, spyOn, test } from "bun:test";
import { ROOM_LIMITS } from "@openedbot/roster/domain/bot-mode";
import { ROUTINE_ERROR_BUSY_RETRIES_EXHAUSTED, ROUTINE_ERROR_GROUP_EMPTY } from "@openedbot/contracts-errors";
import {
  ROUTINE_LIMITS,
  countMissedOccurrences,
  nextOccurrence,
  routineFireText,
} from "../src/domain/routines";
import { fireDueRoutine } from "../src/application/routines";
import { insertedRow } from "../../../tests/sql-insert-columns";

type Query = { sql: string; values: unknown[] };

function inserted(queries: Query[], table: "runs" | "workflows"): Record<string, unknown> {
  const query = queries.find(({ sql }) => sql.includes(`insert into ${table}`));
  if (!query) throw new Error(`no insert into ${table}`);
  return insertedRow(query.sql, query.values);
}

type DueRow = {
  id: string;
  organizationId: string;
  botId: string | null;
  groupId: string | null;
  threadId: string;
  groupDefaultResponder: unknown;
  name: string;
  schedule: string;
  timezone: string;
  message: string;
  createdByUserId: string | null;
  neverWait: boolean;
  nextRunAt: Date;
  missedCount: number;
  busyRetries: number;
  autonomyEnabled: boolean | null;
  autonomyMaxDepth: number | null;
  autonomyMaxSteps: number | null;
  autonomyMaxHandoffs: number | null;
  autonomyTimeoutSeconds: number | null;
  autonomyTokenBudget: number | null;
};

type MemberRow = {
  id: string;
  slug: string;
  position: number;
  autonomyEnabled: boolean;
  autonomyMaxDepth: number;
  autonomyMaxSteps: number;
  autonomyMaxHandoffs: number;
  autonomyTimeoutSeconds: number;
  autonomyTokenBudget: number;
};

function dueRow(overrides: Partial<DueRow> = {}): DueRow {
  return {
    id: "routine-1",
    organizationId: "org-1",
    botId: "bot-1",
    groupId: null,
    threadId: "thread-1",
    groupDefaultResponder: { kind: "everyone" },
    name: "Revue",
    schedule: "0 * * * *",
    timezone: "UTC",
    message: "Fais le point.",
    createdByUserId: "user-1",
    neverWait: false,
    nextRunAt: new Date("2026-01-01T09:00:00.000Z"),
    missedCount: 0,
    busyRetries: 0,
    autonomyEnabled: true,
    autonomyMaxDepth: 3,
    autonomyMaxSteps: 8,
    autonomyMaxHandoffs: 4,
    autonomyTimeoutSeconds: 1800,
    autonomyTokenBudget: 120_000,
    ...overrides,
  };
}

function fakeDb(state: {
  due: DueRow | null;
  busy?: boolean;
  subscriptionStatus?: string | null;
  members?: MemberRow[];
  claimOnce?: { remaining: number };
}): { db: Bun.SQL; queries: Query[] } {
  const queries: Query[] = [];
  const tx = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!("raw" in (strings as TemplateStringsArray))) {
      return `(${(strings as unknown[]).map(String).join(",")})`;
    }
    const sql = Array.from(strings as TemplateStringsArray).join(" ");
    // A fragment (the subscription port's admission relation) is no query:
    // it is interpolated into the claim, as Bun composes it.
    if (sql.trimStart().startsWith("(")) return { fragment: sql };
    queries.push({ sql, values });
    if (sql.includes("from routines r")) {
      const billingBypass = values.find((value) => typeof value === "boolean") === true;
      if (!billingBypass && state.subscriptionStatus !== "active" && state.subscriptionStatus !== "trialing") {
        return Promise.resolve([]);
      }
      if (state.claimOnce) {
        if (state.claimOnce.remaining <= 0) return Promise.resolve([]);
        state.claimOnce.remaining -= 1;
      }
      return Promise.resolve(state.due ? [state.due] : []);
    }
    if (sql.includes("from group_members")) return Promise.resolve(state.members ?? []);
    if (sql.includes("from threads")) return Promise.resolve(state.due ? [{ id: state.due.threadId }] : []);
    if (sql.includes("from runs")) return Promise.resolve(state.busy ? [{ id: "run-busy" }] : []);
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
  const db = tx as Bun.SQL & { begin: (callback: (transaction: Bun.SQL) => Promise<unknown>) => Promise<unknown> };
  db.begin = (async (callback: (transaction: Bun.SQL) => Promise<unknown>) => callback(tx)) as Bun.SQL["begin"];
  return { db, queries };
}

const NOW = new Date("2026-01-01T15:00:00.000Z");

describe("fireDueRoutine", () => {
  test("tir nominal : message, workflow routine, run queued, missed_count, busy_retries remis à zéro", async () => {
    const due = dueRow();
    const { db, queries } = fakeDb({ due, subscriptionStatus: "active" });

    expect(await fireDueRoutine(db, false, NOW)).toBe(true);

    expect(inserted(queries, "workflows")).toMatchObject({
      kind: "routine", status: "queued", recovery_state: { routineId: due.id, trigger: "scheduled" },
    });
    expect(inserted(queries, "runs")).toMatchObject({
      status: "queued", step_kind: "root", input: routineFireText(due.name, due.message),
    });

    const message = queries.find((query) => query.sql.includes("insert into messages"));
    expect(message?.values).toContainEqual([{ type: "text", text: routineFireText(due.name, due.message) }]);

    const missed = countMissedOccurrences(due.schedule, due.nextRunAt, NOW, due.timezone);
    expect(missed).toBe(6);
    const update = queries.find((query) => query.sql.includes("update routines") && query.sql.includes("last_run_at"));
    expect(update?.sql).toContain("missed_count = missed_count +");
    expect(update?.sql).toContain("busy_retries = 0");
    expect(update?.values).toContain(missed);
    expect(update?.values).toContainEqual(nextOccurrence(due.schedule, NOW, due.timezone));
  });

  test("PERM2-9 : le workflow fige « Ne jamais attendre » de la routine au tir", async () => {
    for (const neverWait of [true, false]) {
      const { db, queries } = fakeDb({ due: dueRow({ neverWait }), subscriptionStatus: "active" });
      expect(await fireDueRoutine(db, false, NOW)).toBe(true);
      expect(inserted(queries, "workflows").never_wait).toBe(neverWait);
    }
  });

  test("fil occupé : report +60 s et incrément de busy_retries", async () => {
    const due = dueRow({ busyRetries: 3 });
    const { db, queries } = fakeDb({ due, busy: true, subscriptionStatus: "active" });

    expect(await fireDueRoutine(db, false, NOW)).toBe(true);

    expect(queries.some((query) => query.sql.includes("insert into workflows"))).toBe(false);
    const execution = queries.find((query) => query.sql.includes("insert into routine_executions"));
    expect(execution?.values).toContain("deferred");
    const update = queries.find((query) => query.sql.includes("update routines"));
    expect(update?.sql).toContain("interval '1 second'");
    expect(update?.values).toContain(60);
    expect(update?.values).toContain(4);
    expect(update?.sql).toContain("busy_retries");
  });

  test("plafond de reports : saute l'occurrence, remet busy_retries à zéro, journalise", async () => {
    const due = dueRow({ busyRetries: ROUTINE_LIMITS.maxBusyRetries, nextRunAt: NOW });
    const { db, queries } = fakeDb({ due, busy: true, subscriptionStatus: "active" });
    const spy = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await fireDueRoutine(db, false, NOW)).toBe(true);
      expect(spy.mock.calls.some((args) => String(args[0]).includes("worker.routine_busy_retries_exhausted"))).toBe(true);
    } finally {
      spy.mockRestore();
    }

    expect(queries.some((query) => query.sql.includes("insert into workflows"))).toBe(false);
    const execution = queries.find((query) => query.sql.includes("insert into routine_executions"));
    expect(execution?.values).toContain("abandoned");
    expect(execution?.values).toContain(ROUTINE_ERROR_BUSY_RETRIES_EXHAUSTED);
    const update = queries.find((query) => query.sql.includes("update routines"));
    expect(update?.sql).toContain("busy_retries = 0");
    expect(update?.sql).toContain("missed_count = missed_count +");
    expect(update?.values).toContainEqual(nextOccurrence(due.schedule, NOW, due.timezone));
    expect(update?.values).toContain(1);
  });

  test("calcule missed_count entre l'échéance et maintenant, plafonné", async () => {
    const due = dueRow({
      schedule: "* * * * *",
      nextRunAt: new Date("2026-01-01T12:00:00.000Z"),
    });
    const { db, queries } = fakeDb({ due, subscriptionStatus: "active" });

    expect(await fireDueRoutine(db, false, NOW)).toBe(true);

    const update = queries.find((query) => query.sql.includes("update routines") && query.sql.includes("last_run_at"));
    expect(update?.values).toContain(ROUTINE_LIMITS.maxMissedCounted);
  });

  test("filtre abonnement : billing imposé et statut hors active/trialing → pas de tir", async () => {
    const due = dueRow();
    const { db, queries } = fakeDb({ due, subscriptionStatus: "canceled" });

    expect(await fireDueRoutine(db, true, NOW)).toBe(false);

    expect(queries.some((query) => query.sql.includes("from routines r"))).toBe(true);
    expect(queries.some((query) => query.sql.includes("insert into workflows"))).toBe(false);
    const claim = queries.find((query) => query.sql.includes("from routines r"));
    // The subscription comes from the port's relation, never from the table.
    expect(claim?.sql).not.toContain("subscriptions");
    expect(claim?.values[0]).toEqual({ fragment: expect.stringContaining("where false") });
    expect(claim?.values[1]).toBe(false);
    expect(claim?.sql).toContain("s.status in ('active','trialing')");
  });

  test("aucune routine due : false, aucune écriture", async () => {
    const { db, queries } = fakeDb({ due: null, subscriptionStatus: "active" });
    expect(await fireDueRoutine(db, false, NOW)).toBe(false);
    expect(queries.some((query) => query.sql.includes("insert into"))).toBe(false);
  });

  test("claim SQL : for update skip locked, et un second worker ne reprend pas la ligne", async () => {
    const due = dueRow();
    const gate = { remaining: 1 };
    const first = fakeDb({ due, subscriptionStatus: "active", claimOnce: gate });
    const second = fakeDb({ due, subscriptionStatus: "active", claimOnce: gate });

    expect(await fireDueRoutine(first.db, false, NOW)).toBe(true);
    expect(await fireDueRoutine(second.db, false, NOW)).toBe(false);

    const claim = first.queries.find((query) => query.sql.includes("from routines r"));
    expect(claim?.sql).toContain("for update of r skip locked");
    expect(second.queries.some((query) => query.sql.includes("insert into workflows"))).toBe(false);
  });

  test("Europe/Paris : next_run_at suit la bascule de printemps puis d'automne", async () => {
    const spring = new Date("2026-03-29T07:00:00.000Z");
    const springDue = dueRow({
      schedule: "0 9 * * *",
      timezone: "Europe/Paris",
      nextRunAt: spring,
    });
    const springDb = fakeDb({ due: springDue, subscriptionStatus: "active" });
    expect(await fireDueRoutine(springDb.db, false, spring)).toBe(true);
    const springUpdate = springDb.queries.find((query) =>
      query.sql.includes("update routines") && query.sql.includes("last_run_at"));
    expect(springUpdate?.values).toContainEqual(nextOccurrence("0 9 * * *", spring, "Europe/Paris"));
    expect(nextOccurrence("0 9 * * *", spring, "Europe/Paris")?.toISOString()).toBe("2026-03-30T07:00:00.000Z");

    const autumn = new Date("2026-10-25T08:00:00.000Z");
    const autumnDue = dueRow({
      schedule: "0 9 * * *",
      timezone: "Europe/Paris",
      nextRunAt: autumn,
    });
    const autumnDb = fakeDb({ due: autumnDue, subscriptionStatus: "active" });
    expect(await fireDueRoutine(autumnDb.db, false, autumn)).toBe(true);
    const autumnUpdate = autumnDb.queries.find((query) =>
      query.sql.includes("update routines") && query.sql.includes("last_run_at"));
    expect(autumnUpdate?.values).toContainEqual(nextOccurrence("0 9 * * *", autumn, "Europe/Paris"));
    expect(nextOccurrence("0 9 * * *", autumn, "Europe/Paris")?.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });

  test("tir de salon : workflow kind group, budget maxMemberTurns, historique fired", async () => {
    const due = dueRow({
      botId: null,
      groupId: "group-1",
      threadId: "group-thread-1",
      nextRunAt: NOW,
    });
    const { db, queries } = fakeDb({
      due,
      subscriptionStatus: "active",
      members: [{
        id: "bot-1",
        slug: "scout",
        position: 0,
        autonomyEnabled: true,
        autonomyMaxDepth: 3,
        autonomyMaxSteps: 8,
        autonomyMaxHandoffs: 4,
        autonomyTimeoutSeconds: 1800,
        autonomyTokenBudget: 120_000,
      }, {
        id: "bot-2",
        slug: "neo",
        position: 1,
        autonomyEnabled: true,
        autonomyMaxDepth: 3,
        autonomyMaxSteps: 8,
        autonomyMaxHandoffs: 4,
        autonomyTimeoutSeconds: 1800,
        autonomyTokenBudget: 120_000,
      }],
    });

    expect(await fireDueRoutine(db, false, NOW)).toBe(true);

    expect(inserted(queries, "workflows")).toMatchObject({
      kind: "group", status: "queued", max_steps: ROOM_LIMITS.maxMemberTurns,
      recovery_state: { routineId: due.id, trigger: "scheduled" },
    });
    expect(inserted(queries, "runs").step_kind).toBe("group");
    const execution = queries.find((query) => query.sql.includes("insert into routine_executions"));
    expect(execution?.values).toContain("fired");
  });

  test("salon vide : GROUP_EMPTY journalisé, aucun workflow", async () => {
    const due = dueRow({
      botId: null,
      groupId: "group-1",
      threadId: "group-thread-1",
      nextRunAt: NOW,
    });
    const { db, queries } = fakeDb({ due, subscriptionStatus: "active", members: [] });

    expect(await fireDueRoutine(db, false, NOW)).toBe(true);
    expect(queries.some((query) => query.sql.includes("insert into workflows"))).toBe(false);
    const execution = queries.find((query) => query.sql.includes("insert into routine_executions"));
    expect(execution?.values).toContain("group_empty");
    expect(execution?.values).toContain(ROUTINE_ERROR_GROUP_EMPTY);
    const update = queries.find((query) => query.sql.includes("update routines"));
    expect(update?.sql).toContain("missed_count = missed_count +");
  });
});
