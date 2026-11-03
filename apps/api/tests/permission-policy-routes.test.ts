import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { permissionPolicyRoutes } from "../src/routes/identity/permission-policy-routes";
import { HttpError } from "../src/interfaces/http/http-error";

const base: AuthContext = { sessionId: "s", organizationId: "org-1", userId: "user-1", role: "owner", kind: "web", credentialHash: "c" };

function fakeDb(state: { pipeline: string; writeStatus?: string }, statements: string[]): SQL {
  let saved = false;
  const tx = ((strings: TemplateStringsArray) => {
    const sql = [...strings].join(" ");
    statements.push(sql);
    if (sql.includes("set_organization_permission_policy")) {
      saved = state.writeStatus === undefined || state.writeStatus === "saved";
      return Promise.resolve([{ status: state.writeStatus ?? "saved", version: 1 }]);
    }
    if (sql.includes("from organization_permission_policies")) {
      return Promise.resolve(saved ? [{ maxMode: "auto", enforceReview: true, rulesMode: "adds", commandBlocklist: ["rm -rf"], version: 1, updatedAt: new Date(0) }] : []);
    }
    if (sql.includes("from organizations")) return Promise.resolve([{ pipeline: state.pipeline }]);
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

function mount(db: SQL, auth: AuthContext) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/", permissionPolicyRoutes(db));
  return app;
}

const body = { maxMode: "auto", enforceReview: true, rulesMode: "adds", commandBlocklist: ["rm   -rf"], expectedVersion: 0 };
const put = (app: ReturnType<typeof mount>, payload: unknown = body) =>
  app.request("/", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

describe("/api/organization/permissions", () => {
  test("a member reads the policy, without the right to edit it", async () => {
    const response = await mount(fakeDb({ pipeline: "v2" }, []), { ...base, role: "member" }).request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      policy: { maxMode: null, enforceReview: false, rulesMode: "adds", commandBlocklist: [], version: 0, updatedAt: null },
      canEdit: false,
      enforced: true,
    });
  });

  test("a member or an agency cannot write, and nothing reaches the database", async () => {
    for (const role of ["member", "agency"] as const) {
      const statements: string[] = [];
      const response = await put(mount(fakeDb({ pipeline: "v2" }, statements), { ...base, role }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "ROLE_REQUIRED" } });
      expect(statements.some((sql) => sql.includes("set_organization_permission_policy"))).toBe(false);
    }
  });

  test("an owner or an admin saves the canonical policy", async () => {
    for (const role of ["owner", "admin"] as const) {
      const response = await put(mount(fakeDb({ pipeline: "v2" }, []), { ...base, role }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ canEdit: true, policy: { maxMode: "auto", commandBlocklist: ["rm -rf"], version: 1 } });
    }
  });

  test("a malformed blocklist is refused before the database", async () => {
    const statements: string[] = [];
    const response = await put(mount(fakeDb({ pipeline: "v2" }, statements), base), { ...body, commandBlocklist: ["rm; ls"] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "PERMISSION_BLOCKLIST_INVALID" } });
    expect(statements.some((sql) => sql.includes("set_organization_permission_policy"))).toBe(false);
  });

  test("a stale version and a legacy organization are refused with their own codes", async () => {
    const conflict = await put(mount(fakeDb({ pipeline: "v2", writeStatus: "conflict" }, []), base));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "PERMISSION_POLICY_CONFLICT" } });
    const legacy = await put(mount(fakeDb({ pipeline: "legacy", writeStatus: "pipeline_legacy" }, []), base));
    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toEqual({ error: { code: "PERMISSION_POLICY_REQUIRES_PIPELINE" } });
  });
});
