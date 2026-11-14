/**
 * A workspace opens on a live direct membership only. What installed consoles
 * still read stays on the wire as constants (`kind: "personal"`,
 * `agencyAvailable: false`), and a header they may still send is ignored.
 * Real middleware and routes; only the database boundary is replaced.
 */
import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { authMiddleware, type AppVariables } from "../src/routes/identity/auth";
import { workspaceRoutes } from "../src/routes/identity/workspace-routes";

const ORG = "85000000-0000-4000-8000-000000000001";
const OTHER_ORG = "85000000-0000-4000-8000-000000000002";
const USER = "85000000-0000-4000-8000-0000000000aa";
const TOKEN = "bearer-token";

/** `role`: what `workspace_access` answers for ORG (`"agency"`: a delegated access a database before 0190 could still derive). */
function fixture(options: { role?: string | null; memberships?: Array<{ id: string; role: string }>; ownsPersonal?: boolean } = {}) {
  const statements: string[] = [];
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push(sql);
    if (sql.startsWith("select s.id,")) {
      return [{ id: "session-1", organizationId: ORG, userId: USER, kind: "web", csrfHash: null, assistedBy: null }];
    }
    if (sql.includes("from workspace_access(")) return options.role === undefined ? [{ role: "owner" }] : [{ role: options.role }];
    if (sql.startsWith("select organization_id as id, role from memberships")) return options.memberships ?? [{ id: ORG, role: "owner" }];
    if (sql.startsWith("select organization_id as \"organizationId\" from memberships")) return options.ownsPersonal ? [{ organizationId: ORG }] : [];
    if (sql.startsWith("select id from organizations where id = ? and personal_owner_user_id")) return options.ownsPersonal ? [{ id: values[0] }] : [];
    if (sql.startsWith("select id, name, slug from organizations")) return [{ id: values[0], name: `Org ${String(values[0]).slice(-1)}`, slug: `org-${String(values[0]).slice(-1)}` }];
    return [];
  }) as unknown as SQL;
  db.begin = (async (callback: (tx: SQL) => Promise<unknown>) => callback(db)) as SQL["begin"];
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError((error, c) => error instanceof HttpError
    ? c.json({ code: error.code }, error.status as 403)
    : c.json({ code: "UNEXPECTED", message: String(error) }, 500));
  app.use("/api/*", authMiddleware(db));
  app.get("/api/probe", (c) => c.json(c.get("auth")));
  app.route("/api/account", workspaceRoutes(db, { billingEnforced: false, environment: "test" }));
  const request = (path: string, init: RequestInit = {}) => app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string> | undefined) },
  });
  return { request, statements };
}

describe("workspace access is a live direct membership", () => {
  test("a request still carrying X-OpenedBot-Fleet (or ?fleetId=) is a plain member request", async () => {
    const { request } = fixture();
    const response = await request(`/api/probe?fleetId=${OTHER_ORG}`, { headers: { "X-OpenedBot-Fleet": OTHER_ORG, "X-OpenedBot-Organization": ORG } });
    expect(response.status).toBe(200);
    const auth = await response.json() as Record<string, unknown>;
    expect(auth).toMatchObject({ organizationId: ORG, userId: USER, role: "owner" });
    expect(Object.keys(auth)).not.toContain("actingFleetId");
    expect(Object.keys(auth)).not.toContain("organizationKind");
  });

  test("a role that is not a membership role opens nothing, and workspace_access is read for its role only", async () => {
    const { request, statements } = fixture({ role: "agency" });
    const response = await request("/api/probe", { headers: { "X-OpenedBot-Organization": ORG } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "WORKSPACE_ACCESS_REVOKED" });
    const reads = statements.filter((sql) => sql.includes("from workspace_access("));
    expect(reads.length).toBeGreaterThan(0);
    for (const sql of reads) expect(sql).toStartWith("select role from workspace_access(");
  });
});

describe("/api/account wire compatibility", () => {
  test("GET /workspaces lists the direct memberships with kind personal and agencyAvailable false", async () => {
    const { request, statements } = fixture({ memberships: [{ id: ORG, role: "owner" }, { id: OTHER_ORG, role: "member" }] });
    const response = await request("/api/account/workspaces");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      userId: USER,
      agencyAvailable: false,
      workspaces: [
        { id: ORG, name: "Org 1", slug: "org-1", role: "owner", kind: "personal" },
        { id: OTHER_ORG, name: "Org 2", slug: "org-2", role: "member", kind: "personal" },
      ],
    });
    for (const sql of statements.filter((statement) => statement.includes("from organizations"))) expect(sql).not.toMatch(/\bkind\b/);
  });

  test("POST /organizations accepts no kind or \"personal\", and the insert leaves kind to its default", async () => {
    for (const body of [{ name: "Perso" }, { kind: "personal", name: "Perso" }]) {
      const { request, statements } = fixture();
      const response = await request("/api/account/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ kind: "personal" });
      const insert = statements.find((sql) => sql.startsWith("insert into organizations"));
      expect(insert).toBeDefined();
      expect(insert).not.toMatch(/\bkind\b/);
    }
  });

  test("POST /organizations refuses any other kind with a clear 400, before any write", async () => {
    for (const kind of ["agency", "team", 1]) {
      const { request, statements } = fixture();
      const response = await request("/api/account/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, name: "Agence" }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "ORGANIZATION_KIND_INVALID" });
      expect(statements.some((sql) => sql.startsWith("insert into"))).toBe(false);
    }
  });
});
