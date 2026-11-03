import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { InboxItemDto } from "@openedbot/contracts-api";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { inboxRoutes, readInboxLimit, sortInboxItems } from "../src/routes/inbox/inbox-routes";

const owner: AuthContext = {
  sessionId: "session-1",
  organizationId: "org-1",
  userId: "user-1",
  role: "owner",
  kind: "web",
  credentialHash: "credential",
};

type Call = { sql: string; values: unknown[] };

function fakeDb(handler: (sql: string, values: unknown[]) => unknown[]) {
  const calls: Call[] = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ? ").replace(/\s+/gu, " ").trim();
    calls.push({ sql, values });
    return handler(sql, values);
  }) as unknown as SQL;
  (tx as unknown as { begin(callback: (inner: Bun.TransactionSQL) => Promise<unknown>): Promise<unknown> }).begin =
    async (callback) => callback(tx as unknown as Bun.TransactionSQL);
  return { db: tx, calls };
}

function mount(db: SQL, auth: AuthContext = owner) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/", inboxRoutes(db));
  return app;
}

// Les trois listes se distinguent par leur colonne de tête ; la requête de
// comptage porte les trois alias dans une seule projection scalaire.
function isApprovalsQuery(sql: string): boolean {
  return sql.includes('a.id as "approvalId"');
}
function isNeedsReviewQuery(sql: string): boolean {
  return sql.includes('w.id as "workflowId"');
}
function isNeedsYouQuery(sql: string): boolean {
  return sql.includes('g.id as "groupId"');
}
function isCountsQuery(sql: string): boolean {
  return sql.includes('as "approval"') && sql.includes('as "needsReview"') && sql.includes('as "needsYou"');
}

const NOW = "2026-08-31T12:00:00.000Z";
const OLDER = "2026-08-30T09:00:00.000Z";
const NEWEST = "2026-08-31T15:00:00.000Z";

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: "approval-1",
    runId: "run-1",
    threadId: "thread-1",
    createdAt: NOW,
    expiresAt: NOW,
    summary: "Merge la PR",
    isDefaultThread: false,
    botId: "bot-1",
    botSlug: "atlas",
    botName: "Atlas",
    botFace: null,
    groupId: null,
    groupName: null,
    ...overrides,
  };
}

function needsReviewRow(overrides: Record<string, unknown> = {}) {
  return {
    workflowId: "workflow-1",
    threadId: "thread-2",
    status: "unknown",
    errorCode: "HERMES_CREATE_AMBIGUOUS",
    errorMessage: "unknown",
    createdAt: OLDER,
    endedAt: null,
    updatedAt: NOW,
    isDefaultThread: true,
    botId: "bot-1",
    botSlug: "atlas",
    botName: "Atlas",
    botFace: null,
    groupId: null,
    groupName: null,
    initiatorName: null,
    initiatorEmail: "jane.doe@example.com",
    ...overrides,
  };
}

function needsYouRow(overrides: Record<string, unknown> = {}) {
  return {
    groupId: "group-1",
    groupName: "Salon ops",
    updatedAt: OLDER,
    threadId: "thread-3",
    isDefaultThread: false,
    ...overrides,
  };
}

const EMPTY_COUNTS = [{ approval: 0, needsReview: 0, needsYou: 0 }];

describe("readInboxLimit", () => {
  test("defaults to 50, caps at 200, same logic as readHistoryLimit", () => {
    expect(readInboxLimit(null)).toBe(50);
    expect(readInboxLimit("10")).toBe(10);
    expect(readInboxLimit("0")).toBe(50);
    expect(readInboxLimit("-5")).toBe(50);
    expect(readInboxLimit("2.5")).toBe(50);
    expect(readInboxLimit("100000")).toBe(200);
  });
});

describe("sortInboxItems", () => {
  test("sorts occurredAt desc and is stable across equal timestamps", () => {
    const a: InboxItemDto = {
      kind: "needs_you", id: "g1", occurredAt: OLDER, threadId: "t1", isDefaultThread: false,
      botId: null, botSlug: null, botName: null, botFace: null, groupId: "g1", groupName: "Salon",
    };
    const b: InboxItemDto = {
      kind: "approval", id: "ap1", occurredAt: NEWEST, threadId: "t2", isDefaultThread: false,
      botId: "b1", botSlug: "atlas", botName: "Atlas", botFace: null, groupId: null, groupName: null,
      approvalId: "ap1", runId: "r1", summary: null, expiresAt: NEWEST,
    };
    const c: InboxItemDto = {
      kind: "needs_review", id: "w1", occurredAt: OLDER, threadId: "t3", isDefaultThread: true,
      botId: "b1", botSlug: "atlas", botName: "Atlas", botFace: null, groupId: null, groupName: null,
      workflowId: "w1", status: "failed", recoveryState: null, errorCode: null, errorMessage: null,
      createdAt: OLDER, endedAt: OLDER, initiatorName: null,
    };
    const sorted = sortInboxItems([a, b, c]);
    expect(sorted.map((item) => item.id)).toEqual(["ap1", "g1", "w1"]);
  });
});

describe("GET /inbox", () => {
  test("emits the three list queries and one counts query, all scoped to the org, and never selects the approval command", async () => {
    const fake = fakeDb((sql) => {
      if (isApprovalsQuery(sql)) return [];
      if (isNeedsReviewQuery(sql)) return [];
      if (isNeedsYouQuery(sql)) return [];
      if (isCountsQuery(sql)) return EMPTY_COUNTS;
      return [];
    });

    const response = await mount(fake.db).request("/inbox");
    expect(response.status).toBe(200);

    const approvalsCalls = fake.calls.filter(({ sql }) => isApprovalsQuery(sql));
    const needsReviewCalls = fake.calls.filter(({ sql }) => isNeedsReviewQuery(sql));
    const needsYouCalls = fake.calls.filter(({ sql }) => isNeedsYouQuery(sql));
    const countsCalls = fake.calls.filter(({ sql }) => isCountsQuery(sql));
    expect(approvalsCalls).toHaveLength(1);
    expect(needsReviewCalls).toHaveLength(1);
    expect(needsYouCalls).toHaveLength(1);
    expect(countsCalls).toHaveLength(1);

    for (const call of [...approvalsCalls, ...needsReviewCalls, ...needsYouCalls, ...countsCalls]) {
      expect(call.values).toContain("org-1");
      expect(call.sql).not.toContain("a.command");
    }
    expect(approvalsCalls[0]!.sql).toContain('left(a.description, 160) as "summary"');
    expect(approvalsCalls[0]!.sql).toContain("a.status = 'pending' and a.forward_state = 'pending'");
    expect(needsReviewCalls[0]!.sql).toContain("w.status in ('unknown', 'failed', 'expired')");
    expect(needsReviewCalls[0]!.sql).toContain("recovery_state->>'resolution'");
    expect(countsCalls[0]!.sql).toContain("recovery_state->>'resolution'");
    expect(needsYouCalls[0]!.sql).toContain("g.needs_you = true");
  });

  test("PERM2-7: a gate under automatic review is neither listed nor counted", async () => {
    const fake = fakeDb((sql) => (isCountsQuery(sql) ? EMPTY_COUNTS : []));
    const response = await mount(fake.db).request("/inbox");
    expect(response.status).toBe(200);
    const approvalsSql = fake.calls.find(({ sql }) => isApprovalsQuery(sql))!.sql;
    const countsSql = fake.calls.find(({ sql }) => isCountsQuery(sql))!.sql;
    expect(approvalsSql).toContain("a.decision_state is distinct from 'reviewing'");
    expect(countsSql).toContain("a.decision_state is distinct from 'reviewing') as \"approval\"");
  });

  test("passes limit to the three list queries but never to the counts query", async () => {
    const fake = fakeDb((sql) => {
      if (isApprovalsQuery(sql)) return [];
      if (isNeedsReviewQuery(sql)) return [];
      if (isNeedsYouQuery(sql)) return [];
      if (isCountsQuery(sql)) return EMPTY_COUNTS;
      return [];
    });

    const response = await mount(fake.db).request("/inbox?limit=7");
    expect(response.status).toBe(200);

    const approvalsCall = fake.calls.find(({ sql }) => isApprovalsQuery(sql))!;
    const needsReviewCall = fake.calls.find(({ sql }) => isNeedsReviewQuery(sql))!;
    const needsYouCall = fake.calls.find(({ sql }) => isNeedsYouQuery(sql))!;
    const countsCall = fake.calls.find(({ sql }) => isCountsQuery(sql))!;
    expect(approvalsCall.values).toContain(7);
    expect(needsReviewCall.values).toContain(7);
    expect(needsYouCall.values).toContain(7);
    expect(countsCall.values).not.toContain(7);
  });

  test("sorts items across the three buckets by occurredAt desc", async () => {
    const fake = fakeDb((sql) => {
      if (isApprovalsQuery(sql)) return [approvalRow({ createdAt: OLDER })];
      if (isNeedsReviewQuery(sql)) return [needsReviewRow({ endedAt: null, updatedAt: NEWEST })];
      if (isNeedsYouQuery(sql)) return [needsYouRow({ updatedAt: NOW })];
      if (isCountsQuery(sql)) return [{ approval: 1, needsReview: 1, needsYou: 1 }];
      return [];
    });

    const response = await mount(fake.db).request("/inbox");
    const body = await response.json() as { items: Array<{ kind: string; occurredAt: string }> };
    expect(body.items.map((item) => item.kind)).toEqual(["needs_review", "needs_you", "approval"]);
  });

  test("maps rows without exposing the initiator email, and carries groupId for a salon needs_you item", async () => {
    const fake = fakeDb((sql) => {
      if (isApprovalsQuery(sql)) return [approvalRow({ isDefaultThread: false, groupId: null })];
      if (isNeedsReviewQuery(sql)) {
        return [needsReviewRow({
          initiatorName: null,
          initiatorEmail: "jane.doe@example.com",
          isDefaultThread: true,
        })];
      }
      if (isNeedsYouQuery(sql)) return [needsYouRow({ groupId: "group-9", groupName: "Salon ops" })];
      if (isCountsQuery(sql)) return [{ approval: 1, needsReview: 1, needsYou: 1 }];
      return [];
    });

    const response = await mount(fake.db).request("/inbox");
    const text = await response.text();
    expect(text).not.toContain("@");

    const body = JSON.parse(text) as { items: InboxItemDto[] };
    const approval = body.items.find((item) => item.kind === "approval")!;
    expect(approval.isDefaultThread).toBe(false);
    const needsReview = body.items.find((item) => item.kind === "needs_review") as Extract<InboxItemDto, { kind: "needs_review" }>;
    expect(needsReview.initiatorName).toBe("jane.doe");
    const needsYou = body.items.find((item) => item.kind === "needs_you")!;
    expect(needsYou.groupId).toBe("group-9");
  });

  test("counts are independent of limit: total stays full even when the lists are truncated", async () => {
    const fake = fakeDb((sql) => {
      if (isApprovalsQuery(sql)) return [approvalRow()];
      if (isNeedsReviewQuery(sql)) return [];
      if (isNeedsYouQuery(sql)) return [];
      if (isCountsQuery(sql)) return [{ approval: 12, needsReview: 3, needsYou: 5 }];
      return [];
    });

    const response = await mount(fake.db).request("/inbox?limit=1");
    const body = await response.json() as { counts: { approval: number; needsReview: number; needsYou: number; total: number } };
    expect(body.counts).toEqual({ approval: 12, needsReview: 3, needsYou: 5, total: 20 });
  });
});
