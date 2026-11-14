import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { accountDeletionRoutes, accountDeletionWriteGuard } from "../src/routes/identity/account-deletion-routes";
import { HttpError } from "../src/interfaces/http/http-error";
import { tableSubscriptionPort } from "./fixtures/table-subscription-port";
import { installSubscriptionPort } from "@openedbot/identity/application/subscription-port";
import { isAccountIdentityPath } from "@openedbot/identity/domain/workspace-access";

beforeAll(() => installSubscriptionPort(tableSubscriptionPort));
afterAll(() => installSubscriptionPort(null));
const owner: AuthContext = { sessionId: "session", organizationId: "org-1", userId: "user-1", role: "owner", kind: "web", credentialHash: "credential" };
type Org = { id: string; name: string; role: string; members: number; otherOwners: number };
const solo: Org = { id: "org-1", name: "My workspace", role: "owner", members: 1, otherOwners: 0 };
function fixture(organizations: Org[] = [solo], subscriptionStatus?: string, graceDays = 30) {
  const calls: string[] = [];
  let job: Record<string, unknown> | null = null;
  const tenants = new Map<string, Record<string, unknown>>();
  const deletion = () => ({ reason: "account_deleted", requestedAt: new Date("2026-01-01"), purgeAfter: new Date("2026-02-01"), startedAt: null });
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ? ").replace(/\s+/g, " ").trim(); calls.push(sql);
    if (sql.startsWith("select organization_id as id from memberships")) return organizations.map(({ id }) => ({ id }));
    if (sql.startsWith("select o.id, o.name, m.role")) return organizations.filter(({ id }) => id === values[1]);
    if (sql.startsWith("select status from subscriptions")) return subscriptionStatus ? [{ status: subscriptionStatus }] : [];
    if (sql.includes("from account_deletions")) {
      if (sql.startsWith("delete")) { job = null; return []; }
      return job ? [job] : [];
    }
    if (sql.startsWith("insert into account_deletions")) { job ??= { ...deletion(), userId: values[0], organizationIds: values[1] }; return []; }
    if (sql.startsWith("insert into tenant_deletions")) { const row = deletion(); tenants.set(String(values[0]), row); return [row]; }
    if (sql.includes("from tenant_deletions")) {
      if (sql.startsWith("delete")) { tenants.delete(String(values[0])); return []; }
      if (sql.includes("select exists")) return [{ exists: tenants.size > 0 }];
      const row = tenants.get(String(values[0])); return row ? [row] : [];
    }
    if (sql.startsWith("select id from organizations")) return organizations.filter(({ id }) => id === values[0]);
    return [];
  }) as unknown as SQL;
  db.begin = (async (cb: (tx: SQL) => Promise<unknown>) => cb(db)) as SQL["begin"];
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => { c.set("auth", owner); await next(); });
  app.onError((e, c) => e instanceof HttpError ? c.json({ code: e.code }, e.status as 400) : c.json({ message: String(e) }, 500));
  app.route("/api/account/deletion", accountDeletionRoutes(db, { billingGraceDays: graceDays }));
  app.use("/api/bots", accountDeletionWriteGuard(db));
  app.post("/api/bots", (c) => c.json({ created: true }));
  const schedule = (body: unknown = { confirmation: "DELETE" }) => app.request("/api/account/deletion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const cancel = () => app.request("/api/account/deletion/cancel", { method: "POST" });
  return { app, schedule, cancel, calls, tenants };
}
describe("identity-scoped account closure", () => {
  test("GET exposes the configured delay before confirmation, including zero", async () => {
    for (const days of [30, 0]) {
      const response = await fixture([], undefined, days).app.request("/api/account/deletion");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ graceDays: days, deletion: null });
    }
  });
  test("changed or malformed preview delay cannot schedule; matching and legacy requests work", async () => {
    const f = fixture([], undefined, 0);
    const changed = await f.schedule({ confirmation: "DELETE", expectedGraceDays: 30 });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ code: "ACCOUNT_DELETION_CHANGED" });
    expect(f.calls).toEqual([]);
    for (const expectedGraceDays of [-1, 0.5, "0", null]) {
      expect((await f.schedule({ confirmation: "DELETE", expectedGraceDays })).status).toBe(400);
    }
    expect(f.calls).toEqual([]);
    expect((await f.schedule({ confirmation: "DELETE", expectedGraceDays: 0 })).status).toBe(202);
    expect((await f.schedule()).status).toBe(202);
  });
  test("no workspace, member and multi-workspace accounts are eligible without deleting shared tenants", async () => {
    for (const organizations of [[], [{ ...solo, role: "member", members: 2, otherOwners: 1 }], [solo, { ...solo, id: "org-2", role: "member", members: 3, otherOwners: 1 }]]) {
      const f = fixture(organizations);
      const response = await f.schedule();
      expect(response.status).toBe(202);
      expect([...f.tenants.keys()]).toEqual(organizations.filter((o) => o.members === 1).map((o) => o.id));
      expect(f.calls.some((sql) => sql.startsWith("delete from organizations"))).toBe(false);
    }
  });
  test("exact confirmation and preview are required before adding destructive scope", async () => {
    const f = fixture([solo, { ...solo, id: "org-2" }]);
    expect((await f.schedule({ confirmation: "delete" })).status).toBe(400);
    expect((await f.schedule()).status).toBe(409);
    expect((await f.schedule({ confirmation: "DELETE", organizationIds: ["org-1", "org-2"] })).status).toBe(202);
  });
  test("last shared owner gets an actionable transfer blocker; active solo subscription stays protected", async () => {
    const f = fixture([{ ...solo, members: 2 }]);
    expect(await (await f.schedule()).json()).toEqual({ code: "ACCOUNT_DELETION_TRANSFER_REQUIRED" });
    for (const status of ["active", "trialing"]) {
      expect(await (await fixture([solo], status).schedule()).json()).toEqual({ code: "ACCOUNT_DELETION_SUBSCRIPTION_ACTIVE" });
    }
    expect((await fixture([{ ...solo, members: 2, otherOwners: 1 }], "active").schedule()).status).toBe(202);
  });
  test("retries keep the same deadline, pending identity blocks writes, cancellation is idempotent", async () => {
    const f = fixture();
    const first = await (await f.schedule()).json();
    expect(await (await f.schedule()).json()).toEqual(first);
    expect((await f.app.request("/api/bots", { method: "POST" })).status).toBe(409);
    expect(await (await f.cancel()).json()).toEqual({ cancelled: true, deletion: null });
    expect(await (await f.cancel()).json()).toEqual({ cancelled: false, deletion: null });
  });
  test("claimed tenant prevents cancellation and retains the account request", async () => {
    const f = fixture(); await f.schedule();
    f.tenants.get("org-1")!.startedAt = new Date();
    expect(await (await f.cancel()).json()).toEqual({ code: "ACCOUNT_DELETION_IN_PROGRESS" });
    expect((await f.app.request("/api/bots", { method: "POST" })).status).toBe(409);
  });
  test("account allowlist is exact", () => {
    for (const [path, method] of [["/api/account/deletion", "GET"], ["/api/account/deletion", "POST"], ["/api/account/deletion/cancel", "POST"]]) {
      expect(isAccountIdentityPath(path!, method!)).toBe(true);
    }
    for (const [path, method] of [["/api/account/deletion/other", "POST"], ["/api/account/deletion", "DELETE"], ["/api/account/deletion/cancel", "GET"]]) expect(isAccountIdentityPath(path!, method!)).toBe(false);
  });
});
