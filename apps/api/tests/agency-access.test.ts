import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import { authMiddleware, requireOperator, requireRole, type AppVariables, type AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { hashCredential } from "@openedbot/platform-db/credential";
import type { WorkspaceRole } from "@openedbot/contracts-api";
import { logger } from "@openedbot/platform-observability";

const A = "83000000-0000-4000-8000-000000000001";
const B = "83000000-0000-4000-8000-000000000002";
const AG = "83000000-0000-4000-8000-000000000003";
const OTHER_AG = "83000000-0000-4000-8000-000000000004";

function app(options: { enabled?: boolean; kind?: "web" | "native"; staff?: boolean; targetRole?: WorkspaceRole | null; grants?: string[] } = {}) {
  let tenant = "";
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    if (sql.includes("select s.id,")) return [{ id: "s", organizationId: A, userId: "u", kind: options.kind ?? "web",
      csrfHash: hashCredential("csrf"), impersonatedByStaffUserId: options.staff ? "staff" : null }];
    if (sql.includes("set_config('app.organization_id'")) tenant = String(values[0]);
    if (sql.includes("from workspace_access(")) return tenant === A ? [{ role: "owner", kind: "personal", viaAgencyIds: [] }]
      : [{ role: options.targetRole === null ? null : options.targetRole ?? "agency", kind: "personal", viaAgencyIds: options.grants ?? [AG] }];
    return [];
  }) as unknown as SQL;
  db.begin = (async (callback: (tx: SQL) => Promise<unknown>) => callback(db)) as SQL["begin"];
  const server = new Hono<{ Variables: AppVariables }>();
  server.use("*", authMiddleware(db, options.enabled ?? true));
  server.all("*", (c) => c.json({ organizationId: c.get("auth").organizationId, role: c.get("auth").role,
    ...(c.get("auth").actingFleetId ? { actingFleetId: c.get("auth").actingFleetId } : {}) }));
  server.onError((error, c) => error instanceof HttpError ? c.json({ code: error.code }, error.status as 403) : c.json({ code: "ERROR" }, 500));
  return server;
}

function request(path = "/api/bots", method = "GET") {
  return new Request(`http://localhost${path}`, { method, headers: {
    Cookie: "openedbot_session=test", "X-OpenedBot-Organization": B, "X-CSRF-Token": "csrf",
  } });
}

describe("agency tenant boundary", () => {
  test("one web identity can access the explicitly selected authorized client", async () => {
    const response = await app().request(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ organizationId: B, role: "agency" });
  });
  test("another tab retains its own tenant", async () => {
    const server = app();
    const second = request();
    second.headers.set("X-OpenedBot-Organization", A);
    expect((await (await server.request(second)).json()).organizationId).toBe(A);
    expect((await (await server.request(request())).json()).organizationId).toBe(B);
  });
  test("a revoked or invented membership never falls back to the initial client", async () => {
    const response = await app({ targetRole: null }).request(request());
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("WORKSPACE_ACCESS_REVOKED");
  });
  test("native, staff and disabled deployments cannot cross the session tenant", async () => {
    for (const options of [{ kind: "native" as const }, { staff: true }, { enabled: false }]) {
      expect((await app(options).request(request())).status).toBe(403);
    }
  });
  test("agency rights do not include members, billing, export or permanent purge", async () => {
    for (const [path, method] of [["/api/organization/members", "GET"], ["/api/billing/checkout", "POST"],
      ["/api/pro/billing/checkout", "POST"], ["/api/pro/billing/portal", "POST"], ["/api/pro/billing/subscription", "GET"],
      ["/api/team-exports", "GET"], ["/api/bots/bot?purge=1", "DELETE"], ["/api/account/deletion", "POST"]]) {
      expect((await app().request(request(path, method))).status).toBe(403);
    }
    expect((await app().request(request("/api/bots/bot", "DELETE"))).status).toBe(200);
  });
  test("cross-client writes still require a valid CSRF token", async () => {
    const req = request("/api/bots", "POST"); req.headers.delete("X-CSRF-Token");
    expect((await app().request(req)).status).toBe(403);
  });
  test("download links select an authorized tenant without trusting conflicting contexts", async () => {
    const download = request(`/api/decisions/export?organizationId=${B}`);
    download.headers.delete("X-OpenedBot-Organization");
    expect((await (await app().request(download)).json()).organizationId).toBe(B);
    const conflicting = request(`/api/decisions/export?organizationId=${A}`);
    expect((await app().request(conflicting)).status).toBe(403);
  });
  test("operational authorization never aliases agency to admin", () => {
    const auth = { role: "agency" } as AuthContext;
    expect(() => requireOperator(auth)).not.toThrow();
    expect(() => requireRole(auth, ["owner", "admin"])).toThrow();
  });
  test("an explicit agency mandate uses agency rights even for a personal owner", async () => {
    const server = app({ targetRole: "owner", grants: [AG, OTHER_AG] });
    const selected = request(); selected.headers.set("X-OpenedBot-Fleet", AG);
    expect(await (await server.request(selected)).json()).toEqual({ organizationId: B, role: "agency", actingFleetId: AG });
    expect(await (await server.request(request())).json()).toEqual({ organizationId: B, role: "owner" });
    for (const path of ["/api/organization/members", "/api/billing", "/api/pro/billing/subscription", "/api/team-exports"]) {
      const denied = request(path); denied.headers.set("X-OpenedBot-Fleet", AG);
      expect((await server.request(denied)).status).toBe(403);
      expect((await server.request(request(path))).status).toBe(200);
    }
  });
  test("another live mandate and personal ownership cannot replace the selected revoked mandate", async () => {
    const server = app({ targetRole: "owner", grants: [OTHER_AG] });
    const selected = request(); selected.headers.set("X-OpenedBot-Fleet", AG);
    const denied = await server.request(selected);
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("WORKSPACE_ACCESS_REVOKED");
    selected.headers.set("X-OpenedBot-Fleet", OTHER_AG);
    expect((await server.request(selected)).status).toBe(200);
  });
  test("agency contexts are refused for pinned sessions and disabled deployments", async () => {
    for (const options of [{ kind: "native" as const }, { staff: true }, { enabled: false }]) {
      const selected = request(); selected.headers.set("X-OpenedBot-Fleet", AG);
      expect((await app({ ...options, targetRole: "owner" }).request(selected)).status).toBe(403);
    }
  });
  test("agency download context is explicit, validated and cannot conflict with a header", async () => {
    const server = app({ targetRole: "owner" });
    const download = request(`/api/decisions/export?organizationId=${B}&fleetId=${AG}`);
    expect((await (await server.request(download)).json()).actingFleetId).toBe(AG);
    download.headers.set("X-OpenedBot-Fleet", OTHER_AG);
    expect((await server.request(download)).status).toBe(403);
    const invalid = request(); invalid.headers.set("X-OpenedBot-Fleet", "studio");
    expect((await server.request(invalid)).status).toBe(400);
  });
  test("an agency action journals actor, client and selected agency without request secrets", async () => {
    const entries: unknown[] = [];
    const log = spyOn(logger, "info").mockImplementation(((entry: unknown) => { entries.push(entry); }) as never);
    try {
      const selected = request("/api/bots/fixture-sensitive-segment", "POST");
      selected.headers.set("X-OpenedBot-Fleet", AG);
      expect((await app({ targetRole: "owner" }).request(selected)).status).toBe(200);
      expect(entries).toEqual([expect.objectContaining({ event: "fleet.action", actorUserId: "u", organizationId: B,
        actingFleetId: AG, method: "POST", path: "/*", status: 200 })]);
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain("fixture-sensitive-segment");
      expect(serialized).not.toContain("openedbot_session");
      expect(serialized).not.toContain("csrf");
    } finally { log.mockRestore(); }
  });
});
