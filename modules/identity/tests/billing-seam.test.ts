/**
 * Step 4 seam: identity reads and orders subscriptions only through
 * `SubscriptionPort`, an organization creation runs `onOrganizationCreating`
 * inside its transaction (step 8d: where billing writes the welcome
 * subscription), and a tenant purge runs `onTenantDeleting` inside its. The
 * core default is solo: no subscription, no member limit.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "@openedbot/platform-observability";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { assertCapacity } from "../src/application/member-invitations";
import { installOrganizationCreatedListener } from "../src/application/organization-created";
import {
  installSubscriptionPort,
  isLiveSubscriptionStatus,
  NO_SUBSCRIPTIONS,
  subscriptionPort,
  type SubscriptionPort,
} from "../src/application/subscription-port";
import { processTenantDeletion } from "../src/application/tenant-deletion";
import { installTenantDeletingListener, runTenantDeleting, TenantDeletingError } from "../src/application/tenant-deleting";
import {
  DEFAULT_ORGANIZATION_CREATING_TIMEOUT_MS,
  installOrganizationCreatingListener,
  OrganizationCreatingError,
  runOrganizationCreating,
} from "../src/application/organization-creating";
import { createOrganization } from "../src/sql/accounts";

afterEach(() => {
  installSubscriptionPort(null);
  installTenantDeletingListener(null);
  installOrganizationCreatedListener(null);
  installOrganizationCreatingListener(null);
});

const ORG = "11111111-1111-4111-8111-111111111111";
const flat = (strings: TemplateStringsArray) => strings.join("?").replace(/\s+/g, " ").trim();

/** A tagged-template database recording statements, answering from `rows`. */
function fakeDb(statements: string[], rows: (sql: string) => unknown[] = () => [], order: string[] = []) {
  const tag = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const sql = flat(strings);
    statements.push(sql);
    return rows(sql);
  };
  const begin = async (callback: (tx: typeof tag) => Promise<unknown>) => {
    try {
      const result = await callback(tag);
      order.push("commit");
      return result;
    } catch (error) {
      order.push("rollback");
      throw error;
    }
  };
  return Object.assign(tag, { begin }) as unknown as Db & TransactionDb;
}

describe("SubscriptionPort", () => {
  test("solo default: no subscription, no member limit, no status", async () => {
    expect(subscriptionPort()).toBe(NO_SUBSCRIPTIONS);
    const statements: string[] = [];
    const tx = fakeDb(statements);
    expect("welcome" in NO_SUBSCRIPTIONS).toBe(false);
    expect(await NO_SUBSCRIPTIONS.memberLimit(tx, ORG)).toBeNull();
    expect(await NO_SUBSCRIPTIONS.status(tx, ORG, { lock: true })).toBeNull();
    expect(statements).toEqual([]);
    expect(Object.isFrozen(NO_SUBSCRIPTIONS)).toBe(true);
  });

  test("live statuses are active and trialing only", () => {
    expect(["active", "trialing", "past_due", "canceled", null].map(isLiveSubscriptionStatus)).toEqual([true, true, false, false, false]);
  });

  test("createOrganization (solo) writes no subscription", async () => {
    const statements: string[] = [];
    await createOrganization(fakeDb(statements), { kind: "personal", name: "Solo" }, "user-1", "production", true);
    expect(statements.some((sql) => /subscriptions/i.test(sql))).toBe(false);
  });

  test("createOrganization runs onOrganizationCreating inside the creation transaction, before the commit", async () => {
    const order: string[] = [];
    const calls: unknown[] = [];
    const statements: string[] = [];
    installOrganizationCreatingListener(async (tx, event) => { order.push("creating"); calls.push(event); await tx`insert into subscriptions values (${event.organizationId})`; });
    const created = await createOrganization(fakeDb(statements, () => [], order), { kind: "personal", name: "Perso" }, "user-1", "development", true);
    // The last transaction is the creation (an earlier one checks the personal space).
    expect(order.slice(-2)).toEqual(["creating", "commit"]);
    expect(calls).toEqual([{ organizationId: created.organizationId, kind: "personal", billingEnforced: true, environment: "development" }]);
    // After the organization and its owner membership, in the same transaction.
    const membership = statements.findIndex((sql) => sql.startsWith("insert into memberships"));
    expect(membership).toBeGreaterThan(statements.findIndex((sql) => sql.startsWith("insert into organizations")));
    expect(statements.indexOf("insert into subscriptions values (?)")).toBeGreaterThan(membership);
  });

  test("an agency creation runs it too, with its kind (billing writes nothing for an agency)", async () => {
    const calls: Array<{ kind: string }> = [];
    installOrganizationCreatingListener(async (_tx, event) => { calls.push(event); });
    await createOrganization(fakeDb([]), { kind: "agency", name: "Agence" }, "user-1", "production", true);
    expect(calls.map((event) => event.kind)).toEqual(["agency"]);
  });

  for (const [name, listener, timeoutMs, message] of [
    ["throws", async () => { throw new Error("billing down"); }, undefined, "onOrganizationCreating failed: billing down"],
    ["times out", () => new Promise<void>(() => undefined), 20, "onOrganizationCreating did not answer within 20 ms"],
  ] as const) {
    test(`a hook that ${name} rolls the creation back and announces nothing`, async () => {
      const order: string[] = [];
      const announced: string[] = [];
      installOrganizationCreatedListener(async (id) => { announced.push(id); });
      installOrganizationCreatingListener(listener, { timeoutMs });
      const started = Date.now();
      const failure = await createOrganization(fakeDb([], () => [], order), { kind: "personal", name: "Perso" }, "user-1", "production", false).catch((error) => error);
      expect(failure).toBeInstanceOf(OrganizationCreatingError);
      expect(failure.message).toBe(message);
      // The creation transaction rolls back (an earlier one only read the personal space).
      expect(order.at(-1)).toBe("rollback");
      expect(announced).toEqual([]);
      expect(Date.now() - started).toBeLessThan(1000);
    });
  }

  test("member limit: null (solo) counts nothing; a limit is enforced", async () => {
    const statements: string[] = [];
    await assertCapacity(fakeDb(statements), ORG);
    expect(statements).toEqual([]);

    const port: SubscriptionPort = { ...NO_SUBSCRIPTIONS, memberLimit: async () => 2 };
    installSubscriptionPort(port);
    const full = fakeDb([], (sql) => [{ count: 1 }]);
    await expect(assertCapacity(full, ORG)).rejects.toMatchObject({ code: "MEMBER_QUOTA_REACHED" });
    const room = fakeDb([], (sql) => [{ count: sql.includes("from memberships") ? 1 : 0 }]);
    await assertCapacity(room, ORG);
  });
});

describe("runOrganizationCreating", () => {
  const event = { organizationId: ORG, kind: "personal", billingEnforced: true, environment: "production" } as const;

  test("without a listener (solo) it runs no query", async () => {
    const statements: string[] = [];
    await runOrganizationCreating(fakeDb(statements), event);
    expect(statements).toEqual([]);
  });

  test("a short default timeout, like onTenantDeleting", () => {
    expect(DEFAULT_ORGANIZATION_CREATING_TIMEOUT_MS).toBe(2_000);
  });

  test("bounds the listener with a local statement_timeout, then restores it", async () => {
    const statements: string[] = [];
    const values: unknown[][] = [];
    const db = fakeDb(statements, (sql) => sql.includes("current_setting") ? [{ value: "30s" }] : []);
    const recording = Object.assign(async (strings: TemplateStringsArray, ...rest: unknown[]) => { values.push(rest); return (db as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(strings, ...rest); }, { begin: (db as unknown as { begin: unknown }).begin }) as unknown as TransactionDb;
    installOrganizationCreatingListener(async (tx) => { await tx`select 1`; }, { timeoutMs: 1500 });
    await runOrganizationCreating(recording, event);
    expect(statements).toEqual([
      "select current_setting('statement_timeout') as value",
      "select set_config('statement_timeout', ?, true)",
      "select 1",
      "select set_config('statement_timeout', ?, true)",
    ]);
    expect(values[1]).toEqual(["1500"]);
    expect(values[3]).toEqual(["30s"]);
  });

  test("an error is propagated as OrganizationCreatingError, with its cause", async () => {
    const cause = new Error("plug-in billing: insert failed");
    installOrganizationCreatingListener(async () => { throw cause; });
    const failure = await runOrganizationCreating(fakeDb([]), event).catch((error) => error);
    expect(failure).toBeInstanceOf(OrganizationCreatingError);
    expect(failure.organizationId).toBe(ORG);
    expect(failure.cause).toBe(cause);
  });

  test("a listener that hangs fails after the timeout", async () => {
    installOrganizationCreatingListener(() => new Promise(() => undefined), { timeoutMs: 20 });
    const started = Date.now();
    const failure = await runOrganizationCreating(fakeDb([]), event).catch((error) => error);
    expect(failure).toBeInstanceOf(OrganizationCreatingError);
    expect(failure.message).toBe("onOrganizationCreating did not answer within 20 ms");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("runTenantDeleting", () => {
  const event = { organizationId: ORG, reason: "tenant_deleted" };

  test("without a listener (solo) it runs no query", async () => {
    const statements: string[] = [];
    await runTenantDeleting(fakeDb(statements), event);
    expect(statements).toEqual([]);
  });

  test("bounds the listener with a local statement_timeout, then restores it", async () => {
    const statements: string[] = [];
    const seen: unknown[] = [];
    installTenantDeletingListener(async (tx, received) => { seen.push(received); await tx`select 1`; }, { timeoutMs: 1500 });
    await runTenantDeleting(fakeDb(statements, (sql) => sql.includes("current_setting") ? [{ value: "30s" }] : []), event);
    expect(seen).toEqual([event]);
    expect(statements).toEqual([
      "select current_setting('statement_timeout') as value",
      "select set_config('statement_timeout', ?, true)",
      "select 1",
      "select set_config('statement_timeout', ?, true)",
    ]);
  });

  test("an error is propagated as TenantDeletingError", async () => {
    installTenantDeletingListener(async () => { throw new Error("plug-in agency: keep failed"); });
    const failure = await runTenantDeleting(fakeDb([]), event).catch((error) => error);
    expect(failure).toBeInstanceOf(TenantDeletingError);
    expect(failure.organizationId).toBe(ORG);
    expect(failure.message).toBe("onTenantDeleting failed: plug-in agency: keep failed");
  });

  test("a listener that hangs fails after the timeout", async () => {
    installTenantDeletingListener(() => new Promise(() => undefined), { timeoutMs: 20 });
    const started = Date.now();
    const failure = await runTenantDeleting(fakeDb([]), event).catch((error) => error);
    expect(failure).toBeInstanceOf(TenantDeletingError);
    expect(failure.message).toBe("onTenantDeleting did not answer within 20 ms");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("processTenantDeletion runs onTenantDeleting in the purge transaction", () => {
  /** One claimable deletion, an organization that exists, no blob, no subscription. */
  const purgeRows = (sql: string): unknown[] => {
    if (sql.startsWith('select organization_id as "organizationId", reason from tenant_deletions')) return [{ organizationId: ORG, reason: "tenant_deleted" }];
    if (sql.includes('returning organization_id as "organizationId"')) return [{ organizationId: ORG }];
    if (sql.startsWith("select id from organizations where id")) return [{ id: ORG }];
    if (sql.startsWith("select reason from tenant_deletions")) return [{ reason: "tenant_deleted" }];
    if (sql.startsWith("delete from organizations")) return [{ id: ORG }];
    if (sql.includes("current_setting('statement_timeout')")) return [{ value: "0" }];
    return [];
  };
  const options = { workerId: "worker-1", webAppUrl: "http://localhost" } as Parameters<typeof processTenantDeletion>[1];

  test("solo: the organization is deleted, no listener query", async () => {
    const statements: string[] = [];
    expect(await processTenantDeletion(fakeDb(statements, purgeRows), options)).toBe(true);
    expect(statements.some((sql) => sql.startsWith("delete from organizations"))).toBe(true);
    expect(statements.some((sql) => sql.includes("statement_timeout"))).toBe(false);
  });

  test("the listener runs before the organization row is deleted", async () => {
    const statements: string[] = [];
    installTenantDeletingListener(async (tx) => { await tx`delete from plugin_rows where organization_id = ${ORG}`; });
    await processTenantDeletion(fakeDb(statements, purgeRows), options);
    const hook = statements.indexOf("delete from plugin_rows where organization_id = ?");
    expect(hook).toBeGreaterThan(-1);
    expect(hook).toBeLessThan(statements.findIndex((sql) => sql.startsWith("delete from organizations")));
  });

  for (const [name, listener, timeoutMs] of [
    ["throws", async () => { throw new Error("boom"); }, undefined],
    ["times out", () => new Promise<void>(() => undefined), 20],
  ] as const) {
    test(`a listener that ${name} fails the purge: rollback, no delete, lease released`, async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined as never);
      const error = spyOn(logger, "error").mockImplementation(() => undefined as never);
      try {
        const statements: string[] = [];
        const order: string[] = [];
        installTenantDeletingListener(listener, { timeoutMs });
        await expect(processTenantDeletion(fakeDb(statements, purgeRows, order), options)).rejects.toBeInstanceOf(TenantDeletingError);
        expect(order).toContain("rollback");
        expect(statements.some((sql) => sql.startsWith("delete from organizations"))).toBe(false);
        expect(statements.some((sql) => sql.startsWith("update tenant_deletions set started_at = null"))).toBe(true);
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    });
  }
});
