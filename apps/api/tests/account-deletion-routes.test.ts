import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import type { ApiConfig } from "../src/infrastructure/config";
import { accountDeletionRoutes, accountDeletionWriteGuard } from "../src/routes/identity/account-deletion-routes";
import { HttpError } from "../src/interfaces/http/http-error";
import { tableSubscriptionPort } from "./fixtures/table-subscription-port";
import { installSubscriptionPort } from "@openedbot/identity/application/subscription-port";

// With the plug-in billing the API installs its subscription port at boot;
// these routes are tested with a port that reads the table (test double).
// Solo (no port) is covered in modules/identity.
beforeAll(() => installSubscriptionPort(tableSubscriptionPort));
afterAll(() => installSubscriptionPort(null));

const owner: AuthContext = {
  sessionId: "session-1",
  organizationId: "org-1",
  userId: "user-1",
  role: "owner",
  kind: "web",
  credentialHash: "credential",
};

const config = { billingGraceDays: 30 } as Pick<ApiConfig, "billingGraceDays">;

type Deletion = {
  reason: string;
  requestedAt: Date;
  purgeAfter: Date | null;
  startedAt: Date | null;
  leaseExpiresAt: Date | null;
};

function mount(db: SQL, auth: AuthContext = owner): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED" } }, 500));
  app.route("/", accountDeletionRoutes(db, config));
  return app;
}

function fakeDb(options: {
  calls: string[];
  bindings?: unknown[][];
  subscriptionStatus?: string;
  memberRole?: AuthContext["role"];
  organizationMemberCount?: number;
  userOrganizationCount?: number;
  /** Kind of every OTHER organization of the account; a sole-member agency does not block deletion. */
  otherOrganizationKind?: "personal" | "agency";
  deletion?: Deletion | null;
  activeRun?: boolean;
}): SQL {
  const deletion = options.deletion === undefined ? null : options.deletion;
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    options.calls.push(sql);
    options.bindings?.push(values);
    if (sql.includes("select status from subscriptions")) {
      return Promise.resolve(options.subscriptionStatus ? [{ status: options.subscriptionStatus }] : []);
    }
    if (sql.includes("select role from memberships")) {
      return Promise.resolve([{ role: options.memberRole ?? "owner" }]);
    }
    if (sql.includes("select count(*) as count from memberships where organization_id")) {
      return Promise.resolve([{ count: options.organizationMemberCount ?? 1 }]);
    }
    if (sql.includes("select organization_id as id from memberships")) {
      const others = Math.max(0, (options.userOrganizationCount ?? 1) - 1);
      return Promise.resolve(Array.from({ length: others }, (_, index) => ({ id: `other-${index}` })));
    }
    if (sql.includes("select o.kind, (select count(*) from memberships m")) {
      return Promise.resolve([{ kind: options.otherOrganizationKind ?? "personal", members: 1 }]);
    }
    if (sql.includes("select exists(") && sql.includes("reason = 'account_deleted'")) {
      return Promise.resolve([{ exists: deletion?.reason === "account_deleted" }]);
    }
    if (sql.includes("from tenant_deletions")) {
      return Promise.resolve(deletion ? [deletion] : []);
    }
    if (sql.includes("insert into tenant_deletions")) {
      return Promise.resolve([deletion ?? {
        reason: "account_deleted",
        requestedAt: new Date("2026-08-25T10:00:00.000Z"),
        purgeAfter: new Date("2026-09-24T10:00:00.000Z"),
        startedAt: null,
        leaseExpiresAt: null,
      }]);
    }
    if (options.activeRun && sql.includes('select id, origin_run_id as "originRunId"') && sql.includes("from runs")) {
      return Promise.resolve([{
        id: "run-1", originRunId: null, botId: "bot-1", status: "queued",
        workflowId: null, hermesRunId: null, externalState: "not_started",
      }]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

describe("self-serve account deletion", () => {
  test("GET reports eligibility without ever deleting tenant data", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({ calls })).request("/", { method: "GET" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ eligible: true, blocker: null, deletion: null });
    expect(calls.some((sql) => sql.includes("set_config('app.organization_id'"))).toBe(true);
    expect(calls.some((sql) => sql.includes("set_config('app.authenticating_user_id'"))).toBe(true);
    expect(calls.some((sql) => sql.includes("delete from organizations"))).toBe(false);
  });

  test("POST requires the exact DELETE confirmation", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({ calls })).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "delete" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("DELETE_CONFIRMATION_REQUIRED");
    expect(calls.some((sql) => sql.includes("insert into tenant_deletions"))).toBe(false);
  });

  test("refuses active and trialing subscriptions", async () => {
    for (const subscriptionStatus of ["active", "trialing"]) {
      const calls: string[] = [];
      const response = await mount(fakeDb({ calls, subscriptionStatus })).request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "DELETE" }),
      });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("ACCOUNT_DELETION_SUBSCRIPTION_ACTIVE");
      expect(calls.some((sql) => sql.includes("insert into tenant_deletions"))).toBe(false);
    }
  });

  test("refuses shared organizations and users in multiple organizations", async () => {
    const sharedCalls: string[] = [];
    const shared = await mount(fakeDb({ calls: sharedCalls, organizationMemberCount: 2 })).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
    expect(shared.status).toBe(409);
    expect((await shared.json()).error.code).toBe("ACCOUNT_DELETION_ORGANIZATION_SHARED");

    const multiCalls: string[] = [];
    const multi = await mount(fakeDb({ calls: multiCalls, userOrganizationCount: 2 })).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
    expect(multi.status).toBe(409);
    expect((await multi.json()).error.code).toBe("ACCOUNT_DELETION_MULTIPLE_ORGANIZATIONS");
  });

  test("a sole-member agency organization leaves with the account instead of blocking it", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({ calls, userOrganizationCount: 2, otherOrganizationKind: "agency" })).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
    expect(response.status).toBe(202);
    expect(calls.filter((sql) => sql.includes("insert into tenant_deletions")).length).toBe(2);
  });

  test("schedules an idempotent tenant purge after the configured grace", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const response = await mount(fakeDb({ calls, bindings, activeRun: true })).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ scheduled: true, deletion: { reason: "account_deleted" } });
    const insert = calls.find((sql) => sql.includes("insert into tenant_deletions"));
    expect(insert).toContain("account_deleted");
    expect(insert).toContain("interval '1 day'");
    expect(bindings[calls.findIndex((sql) => sql.includes("insert into tenant_deletions"))]).toContain(30);
    expect(calls.some((sql) => sql.includes("delete from organizations"))).toBe(false);
    expect(calls.some((sql) => sql.includes("update runs set status = 'cancelled'"))).toBe(true);
    expect(calls.some((sql) => sql.includes("on conflict (organization_id) do update"))).toBe(true);
  });

  test("cancels only a pending account deletion and is idempotent", async () => {
    const calls: string[] = [];
    const pending: Deletion = {
      reason: "account_deleted",
      requestedAt: new Date("2026-08-25T10:00:00.000Z"),
      purgeAfter: new Date("2026-09-24T10:00:00.000Z"),
      startedAt: null,
      leaseExpiresAt: null,
    };
    const response = await mount(fakeDb({ calls, deletion: pending })).request("/cancel", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true, deletion: null });
    expect(calls.some((sql) => sql.includes("delete from tenant_deletions") && sql.includes("started_at is null"))).toBe(true);
  });

  test("does not cancel a deletion already claimed by the worker", async () => {
    const calls: string[] = [];
    const claimed: Deletion = {
      reason: "account_deleted",
      requestedAt: new Date("2026-08-25T10:00:00.000Z"),
      purgeAfter: new Date("2026-08-25T10:00:00.000Z"),
      startedAt: new Date("2026-08-25T10:01:00.000Z"),
      leaseExpiresAt: new Date("2026-08-25T10:06:00.000Z"),
    };
    const response = await mount(fakeDb({ calls, deletion: claimed })).request("/cancel", { method: "POST" });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ACCOUNT_DELETION_IN_PROGRESS");
    expect(calls.some((sql) => sql.includes("delete from tenant_deletions"))).toBe(false);
  });

  test("does not let a member cancel the owner's deletion", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({ calls, memberRole: "member", deletion: {
      reason: "account_deleted",
      requestedAt: new Date("2026-08-25T10:00:00.000Z"),
      purgeAfter: new Date("2026-09-24T10:00:00.000Z"),
      startedAt: null,
      leaseExpiresAt: null,
    } }), { ...owner, role: "member", userId: "member-1" }).request("/cancel", { method: "POST" });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("ACCOUNT_DELETION_OWNER_REQUIRED");
    expect(calls.some((sql) => sql.includes("delete from tenant_deletions"))).toBe(false);
  });

  test("blocks new mutations during grace but still lets the owner cancel", async () => {
    const pending: Deletion = {
      reason: "account_deleted", requestedAt: new Date(), purgeAfter: new Date(),
      startedAt: null, leaseExpiresAt: null,
    };
    const db = fakeDb({ calls: [], deletion: pending });
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => { context.set("auth", owner); await next(); });
    app.use("*", accountDeletionWriteGuard(db));
    app.post("/api/bots", (context) => context.json({ created: true }, 201));
    app.post("/api/account/deletion/cancel", (context) => context.json({ cancelled: true }));
    app.onError((error, context) => error instanceof HttpError
      ? context.json({ error: { code: error.code } }, error.status as 400)
      : context.json({ error: { code: "UNEXPECTED" } }, 500));

    const blocked = await app.request("/api/bots", { method: "POST" });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("ACCOUNT_DELETION_PENDING");
    expect((await app.request("/api/account/deletion/cancel", { method: "POST" })).status).toBe(200);
  });
});
