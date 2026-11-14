import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { BlobStore } from "../src/infrastructure/blob-store";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import type { ApiConfig } from "../src/infrastructure/config";
import { HttpError } from "../src/interfaces/http/http-error";
import { messageVersionRoutes, versionRequestHash } from "../src/routes/conversation/message-version-routes";
import { tableSubscriptionPort } from "./fixtures/table-subscription-port";
import { insertedRow } from "../../../tests/sql-insert-columns";
import { installSubscriptionPort } from "@openedbot/platform-db/subscription-port";

// The subscription reads go through the port, as the API installs it.
beforeAll(() => installSubscriptionPort(tableSubscriptionPort));
afterAll(() => installSubscriptionPort(null));

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const BOT = "33333333-3333-4333-8333-333333333333";
const THREAD = "44444444-4444-4444-8444-444444444444";
const MESSAGE = "55555555-5555-4555-8555-555555555555";
const KEY = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-08-26T12:00:00.000Z";

const auth: AuthContext = {
  sessionId: "session", organizationId: ORG, userId: USER,
  role: "member", kind: "web", credentialHash: "credential",
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

const blobs = {
  driver: "file",
  get: async () => new Blob(),
} as unknown as BlobStore;

function source(overrides: Record<string, unknown> = {}) {
  return {
    threadId: THREAD,
    threadTitle: "Audit Hermes",
    botId: BOT,
    botName: "Neo",
    botSlug: "neo",
    messageId: MESSAGE,
    role: "user",
    content: [{ type: "text", text: "question initiale" }],
    authorBotId: null,
    initiatorUserId: USER,
    sequence: 4,
    planOnly: false,
    neverWait: false,
    ...overrides,
  };
}

function mount(db: SQL, options: { runtime?: boolean; blobs?: BlobStore } = {}) {
  let runtimeReads = 0;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/", messageVersionRoutes(db, options.blobs ?? blobs, { billingEnforced: false } as ApiConfig, {
    readRuntime: (async () => {
      runtimeReads += 1;
      return options.runtime === false ? null : { id: "runtime", client: {} } as never;
    }) as never,
    clientFactory: () => ({ toolsets: async () => [] }),
  }));
  return { app, runtimeReads: () => runtimeReads };
}

function request(app: Hono<{ Variables: AppVariables }>, input: Record<string, unknown>) {
  return app.request(`/${THREAD}/messages/${MESSAGE}/versions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": KEY },
    body: JSON.stringify(input),
  });
}

describe("message version persistence contract", () => {
  test("message_versions is append-only, tenant-scoped and idempotent-by-key from the start", () => {
    const sql = readFileSync(new URL("../../../db/migrations/0008_message_versions.sql", import.meta.url), "utf8");
    // Scope to the `create table message_versions` block: FKs of other tables
    // toward messages must not skew the counts.
    const start = sql.indexOf("create table message_versions");
    const end = sql.indexOf("create index message_versions_parent_idx");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const table = sql.slice(start, end);
    expect(table).toContain("root_thread_id uuid not null");
    expect(table).toContain("branch_thread_id uuid not null");
    expect(table).toContain("prefix_truncated boolean not null");
    expect(table.match(/references messages\(organization_id, thread_id, id\) on delete cascade/gu)).toHaveLength(3);
    expect(table).toContain("references threads(organization_id, id) on delete cascade");
    expect(table).toContain("references runs(organization_id, id) on delete cascade");
    expect(table).toContain("references workflows(organization_id, id) on delete cascade");
    expect(table).toContain("on delete set null (created_by_user_id)");
    expect(table).toContain("constraint message_versions_run_key unique (organization_id, run_id)");
    expect(table).toContain("constraint message_versions_workflow_key unique (organization_id, workflow_id)");
    expect(table).toContain("idempotency_key uuid not null");
    expect(table).toContain("request_hash text not null");
    expect(table).toContain("check (request_hash ~ '^[0-9a-f]{64}$')");
    // The creator can disappear without taking the provenance with it.
    expect(table).not.toContain("created_by_user_id uuid not null");
    for (const constraint of [
      "message_versions_root_message_fk",
      "message_versions_parent_message_fk",
      "message_versions_branch_message_fk",
      "message_versions_branch_thread_fk",
      "message_versions_run_fk",
      "message_versions_workflow_fk",
      "message_versions_creator_fk",
      "message_versions_creator_idempotency_key",
    ]) {
      expect(table).toContain(`constraint ${constraint}`);
    }
    expect(sql).toContain("alter table message_versions force row level security");
    expect(sql).toContain("message_versions_tenant");
    expect(sql).not.toMatch(/delete from message_versions|update messages|delete from messages/u);
  });

  test("replays an exact committed key before probing PVE and rejects a divergent payload", async () => {
    const input = { mode: "edit" as const, input: "texte corrigé", expectedVersionCount: 1 };
    const saved = {
      rootThreadId: THREAD,
      rootMessageId: MESSAGE,
      parentThreadId: THREAD,
      parentMessageId: MESSAGE,
      branchThreadId: "77777777-7777-4777-8777-777777777777",
      branchMessageId: "88888888-8888-4888-8888-888888888888",
      runId: "99999999-9999-4999-8999-999999999999",
      workflowId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "edit",
      ordinal: 1,
      requestHash: versionRequestHash(THREAD, MESSAGE, input),
      workflowUpdatedAt: NOW,
      autonomyEnabled: false,
    };
    const exact = fakeDb((sql) => sql.includes("from message_versions version") ? [saved] : []);
    const exactMount = mount(exact.db);
    const response = await request(exactMount.app, input);
    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(exactMount.runtimeReads()).toBe(0);
    expect(await response.json()).toMatchObject({ duplicate: true, branchThreadId: saved.branchThreadId });

    const divergent = await request(mount(exact.db).app, { ...input, input: "autre texte" });
    expect(divergent.status).toBe(409);
    expect(await divergent.json()).toEqual({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
  });

  test("fails closed at the PVE gate before creating a thread or run", async () => {
    const fake = fakeDb(() => []);
    const response = await request(mount(fake.db, { runtime: false }).app, {
      mode: "regenerate", expectedVersionCount: 1,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "RUNTIME_REQUIRED" } });
    expect(fake.calls.some(({ sql }) => /insert into (?:threads|runs|messages|message_versions)/u.test(sql))).toBe(false);
  });

  test("refuses a bot-authored user row", async () => {
    for (const [row, code] of [
      [source({ authorBotId: BOT }), "MESSAGE_VERSION_USER_REQUIRED"],
    ] as const) {
      const fake = fakeDb((sql) => sql.includes("join messages message") ? [row] : []);
      const response = await request(mount(fake.db).app, { mode: "regenerate", expectedVersionCount: 1 });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code } });
      expect(fake.calls.some(({ sql }) => sql.includes("insert into threads"))).toBe(false);
    }
  });

  test("a member cannot branch another member's operator message", async () => {
    const fake = fakeDb((sql) => sql.includes("join messages message")
      ? [source({ initiatorUserId: "77777777-7777-4777-8777-777777777777" })]
      : []);
    const response = await request(mount(fake.db).app, { mode: "regenerate", expectedVersionCount: 1 });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "MESSAGE_VERSION_AUTHOR_REQUIRED" } });
    expect(fake.calls.some(({ sql }) => sql.includes("insert into threads"))).toBe(false);
  });

  test("refuses both an active run and a pending approval before any branch insert", async () => {
    for (const [activity, code] of [
      [{ activeRun: true, pendingApproval: false }, "MESSAGE_VERSION_RUN_ACTIVE"],
      [{ activeRun: true, pendingApproval: true }, "MESSAGE_VERSION_APPROVAL_PENDING"],
    ] as const) {
      const fake = fakeDb((sql) => {
        if (sql.includes("join messages message")) return [source()];
        if (sql.includes("from subscriptions")) return [];
        if (sql.includes("as \"activeRun\"")) return [activity];
        return [];
      });
      const response = await request(mount(fake.db).app, { mode: "regenerate", expectedVersionCount: 1 });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code } });
      expect(fake.calls.some(({ sql }) => sql.includes("insert into threads"))).toBe(false);
    }
  });

  test("enforces the optimistic family size and the per-bot task cap under locks", async () => {
    const baseHandler = (sql: string) => {
      if (sql.includes("join messages message")) return [source()];
      if (sql.includes("from subscriptions")) return [];
      if (sql.includes("as \"activeRun\"")) return [{ activeRun: false, pendingApproval: false }];
      if (sql.includes("from message_versions") && sql.includes("branch_thread_id")) return [];
      return null;
    };
    const stale = fakeDb((sql) => {
      const common = baseHandler(sql);
      if (common) return common;
      if (sql.includes("select count(*) as count from message_versions")) return [{ count: 1 }];
      return [];
    });
    const staleResponse = await request(mount(stale.db).app, { mode: "regenerate", expectedVersionCount: 1 });
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toEqual({ error: { code: "MESSAGE_VERSION_CONFLICT" } });

    const capped = fakeDb((sql) => {
      const common = baseHandler(sql);
      if (common) return common;
      if (sql.includes("select count(*) as count from message_versions")) return [{ count: 0 }];
      if (sql.includes("from bots where")) return [{
        id: BOT, name: "Neo", slug: "neo", autonomyEnabled: false,
        autonomyMaxDepth: 3, autonomyMaxSteps: 8, autonomyMaxHandoffs: 4,
        autonomyTimeoutSeconds: 1_800, autonomyTokenBudget: 50_000,
      }];
      if (sql.includes("select count(*) as count from threads")) return [{ count: 100 }];
      return [];
    });
    const cappedResponse = await request(mount(capped.db).app, { mode: "regenerate", expectedVersionCount: 1 });
    expect(cappedResponse.status).toBe(409);
    expect(await cappedResponse.json()).toEqual({ error: { code: "BOT_TASK_LIMIT_REACHED" } });
  });

  test("returns a navigable tenant-scoped family from either branch task", async () => {
    const branchThread = "77777777-7777-4777-8777-777777777777";
    const branchMessage = "88888888-8888-4888-8888-888888888888";
    const rows = [{
      rootThreadId: THREAD,
      rootMessageId: MESSAGE,
      parentThreadId: THREAD,
      parentMessageId: MESSAGE,
      branchThreadId: branchThread,
      branchMessageId: branchMessage,
      runId: "99999999-9999-4999-8999-999999999999",
      workflowId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "edit",
      ordinal: 1,
    }];
    const fake = fakeDb((sql) => {
      if (sql.startsWith("select id from threads")) return [{ id: branchThread }];
      if (sql.includes("with relevant_roots")) return rows;
      return [];
    });
    const response = await mount(fake.db).app.request(`/${branchThread}/message-versions`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ families: [{
      rootThreadId: THREAD,
      rootMessageId: MESSAGE,
      currentThreadId: branchThread,
      currentMessageId: branchMessage,
      versions: [
        { threadId: THREAD, messageId: MESSAGE, ordinal: 0, kind: "original" },
        { threadId: branchThread, messageId: branchMessage, ordinal: 1, kind: "edit" },
      ],
    }] });
    expect(fake.calls.find(({ sql }) => sql.includes("with relevant_roots"))?.values).toContain(ORG);
  });

  test("creates a fresh Hermes task, copies only the completed prefix and never rewrites the source transcript", async () => {
    let saved: Record<string, unknown> | null = null;
    const attachmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const sourceWithAttachment = source({
      content: [
        { type: "text", text: "question initiale" },
        {
          type: "attachment", id: attachmentId, name: "notes.md",
          contentType: "text/markdown", kind: "document", bytes: 12,
        },
      ],
    });
    const fake = fakeDb((sql, values) => {
      if (sql.includes("from message_versions version")) return saved ? [saved] : [];
      if (sql.includes("join messages message")) return [sourceWithAttachment];
      if (sql.includes("from attachments")) return [{
        id: attachmentId,
        objectKey: `org/${ORG}/${attachmentId}`,
        name: "notes.md",
        contentType: "text/markdown",
        kind: "document",
      }];
      if (sql.includes("from subscriptions")) return [];
      if (sql.includes("as \"activeRun\"")) return [{ activeRun: false, pendingApproval: false }];
      if (sql.includes("from message_versions") && sql.includes("branch_thread_id")) return [];
      if (sql.includes("select count(*) as count from message_versions")) return [{ count: 0 }];
      if (sql.includes("from bots where")) return [{
        id: BOT, name: "Neo", slug: "neo", autonomyEnabled: false,
        autonomyMaxDepth: 3, autonomyMaxSteps: 8, autonomyMaxHandoffs: 4,
        autonomyTimeoutSeconds: 1_800, autonomyTokenBudget: 50_000,
      }];
      if (sql.includes("select count(*) as count from threads")) return [{ count: 1 }];
      if (sql.includes("left join runs source_run") && sql.includes("message.sequence <")) return [{
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        role: "assistant",
        content: [{ type: "text", text: "contexte validé" }, { type: "reasoning", text: "privé" }],
        authorBotId: BOT,
        originalAuthorBotId: BOT,
        originalAuthorName: "Neo",
        replyToId: null,
        createdAt: NOW,
      }];
      if (sql.includes("from bots bot") && sql.includes("default_thread")) return [];
      if (sql.includes("insert into message_versions")) {
        saved = {
          rootThreadId: values[2], rootMessageId: values[3],
          parentThreadId: values[4], parentMessageId: values[5],
          branchThreadId: values[6], branchMessageId: values[7],
          runId: values[8], workflowId: values[9], kind: values[13], ordinal: values[14],
          requestHash: values[12], workflowUpdatedAt: NOW, autonomyEnabled: false,
        };
      }
      return [];
    });
    const response = await request(mount(fake.db, {
      blobs: { ...blobs, get: async () => new Blob(["preuve jointe"]) } as BlobStore,
    }).app, {
      mode: "edit", input: "question corrigée", expectedVersionCount: 1,
    });
    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ duplicate: false, mode: "edit", ordinal: 1, status: "queued" });
    const threadInsert = fake.calls.find(({ sql }) => sql.includes("insert into threads"));
    expect(threadInsert?.sql).toContain("hermes_session_id");
    expect(threadInsert?.values.some((value) => typeof value === "string" && value.startsWith(`openedbot:${ORG}:`))).toBe(true);
    expect(fake.calls.filter(({ sql }) => sql.includes("insert into messages"))).toHaveLength(2);
    expect(JSON.stringify(fake.calls.filter(({ sql }) => sql.includes("insert into messages"))[0]?.values))
      .not.toContain("privé");
    expect(fake.calls.some(({ sql }) => /(?:update|delete) messages/u.test(sql))).toBe(false);
    expect(fake.calls.some(({ sql }) => sql.includes("source_run.status = 'completed'"))).toBe(true);
    const runInsert = fake.calls.find(({ sql }) => sql.includes("insert into runs"));
    expect(runInsert?.values).toContain("question corrigée\n\n<attachment name=notes.md>\npreuve jointe\n</attachment>");
    const branchMessageInsert = fake.calls.filter(({ sql }) => sql.includes("insert into messages"))[1];
    expect(JSON.stringify(branchMessageInsert?.values)).toContain(attachmentId);
  });

  test("a variant of a plan-only, never-wait turn keeps both restrictions", async () => {
    const fake = fakeDb((sql) => {
      if (sql.includes("join messages message")) return [source({ planOnly: true, neverWait: true })];
      if (sql.includes("as \"activeRun\"")) return [{ activeRun: false, pendingApproval: false }];
      if (sql.includes("select count(*) as count from message_versions")) return [{ count: 0 }];
      if (sql.includes("from bots where")) return [{
        id: BOT, name: "Neo", slug: "neo", autonomyEnabled: false,
        autonomyMaxDepth: 3, autonomyMaxSteps: 8, autonomyMaxHandoffs: 4,
        autonomyTimeoutSeconds: 1_800, autonomyTokenBudget: 50_000,
      }];
      if (sql.includes("select count(*) as count from threads")) return [{ count: 1 }];
      if (sql.includes("insert into message_versions")) return [];
      if (sql.includes("from message_versions version") && fake.calls.some((call) => call.sql.includes("insert into message_versions"))) {
        return [{
          rootThreadId: THREAD, rootMessageId: MESSAGE, parentThreadId: THREAD, parentMessageId: MESSAGE,
          branchThreadId: THREAD, branchMessageId: MESSAGE, runId: "run", workflowId: "workflow",
          kind: "regenerate", ordinal: 1, requestHash: "x", workflowUpdatedAt: NOW, autonomyEnabled: false,
        }];
      }
      return [];
    });
    const response = await request(mount(fake.db).app, { mode: "regenerate", expectedVersionCount: 1 });
    expect(response.status).toBe(201);
    const sourceRead = fake.calls.find(({ sql }) => sql.includes("join messages message") && sql.includes("for update of thread"));
    expect(sourceRead?.sql).toContain("coalesce(message_run.plan_only, false) or coalesce(workflow.plan_only, false)");
    expect(sourceRead?.sql).toContain("coalesce(workflow.never_wait, false)");
    const workflowInsert = fake.calls.find(({ sql }) => sql.includes("insert into workflows"))!;
    const workflow = insertedRow(workflowInsert.sql, workflowInsert.values);
    expect([workflow.plan_only, workflow.never_wait]).toEqual([true, true]);
    const runInsert = fake.calls.find(({ sql }) => sql.includes("insert into runs"))!;
    expect(insertedRow(runInsert.sql, runInsert.values).plan_only).toBe(true);
  });
});
