import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import type { Db } from "@openedbot/platform-db";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { isAccountIdentityPath } from "@openedbot/identity/domain/workspace-access";
import { authMiddleware, type AppVariables } from "../src/routes/identity/auth";
import { memberInvitationRoutes } from "../src/routes/identity/member-invitation-routes";
import { memberRoutes } from "../src/routes/identity/member-routes";
import { isSessionlessCorePath } from "../src/interfaces/http/sessionless-paths";

function publicApp(): Hono {
  const server = new Hono();
  server.route("/api/invite/member", memberInvitationRoutes({} as Db, { trustProxy: false }));
  server.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "INTERNAL_ERROR" } }, 500));
  return server;
}

const ORG = "86000000-0000-4000-8000-000000000001";
const USER = "86000000-0000-4000-8000-0000000000aa";

/** The real session middleware and member routes; `role` is what `workspace_access` answers. */
function tenantApp(role: "owner" | "admin" | "member") {
  const statements: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push(sql);
    if (sql.startsWith("select s.id,")) {
      return [{ id: "session-1", organizationId: ORG, userId: USER, kind: "web", csrfHash: null, impersonatedByStaffUserId: null }];
    }
    if (sql.includes("from workspace_access(")) return [{ role }];
    return [];
  }) as unknown as SQL;
  db.begin = (async (callback: (tx: SQL) => Promise<unknown>) => callback(db)) as SQL["begin"];
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError((error, c) => error instanceof HttpError
    ? c.json({ code: error.code }, error.status as 403)
    : c.json({ code: "UNEXPECTED", message: String(error) }, 500));
  app.use("/api/*", authMiddleware(db));
  app.route("/api/organization", memberRoutes(db, { webUrl: "https://app.test" }, { checkDomain: async () => "deliverable" }));
  const request = (path: string, init: RequestInit = {}) => app.request(path, {
    ...init,
    headers: { Authorization: "Bearer token", "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
  return { request, statements };
}

describe("member invitation public routes", () => {
  test("an invalid token is unavailable and never cacheable", async () => {
    const response = await publicApp().request("http://localhost/api/invite/member/not-a-token");
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: { code: "MEMBER_INVITATION_UNAVAILABLE" } });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  test("no account is created through the invitation: there is no register route", async () => {
    const response = await publicApp().request(`http://localhost/api/invite/member/${"a".repeat(43)}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "Long-enough-Password!" }),
    });
    expect(response.status).toBe(404);
  });

  test("the preview passes the session middleware, answering it is an account action", () => {
    const token = "a".repeat(43);
    expect(isSessionlessCorePath(`/api/invite/member/${token}`)).toBe(true);
    expect(isAccountIdentityPath(`/api/invite/member/${token}/accept`, "POST")).toBe(true);
    expect(isAccountIdentityPath(`/api/invite/member/${token}/decline`, "POST")).toBe(true);
    expect(isAccountIdentityPath(`/api/invite/member/${token}/accept`, "GET")).toBe(false);
    expect(isAccountIdentityPath(`/api/invite/member/${token}/register`, "POST")).toBe(false);
  });
});

describe("member invitation tenant routes", () => {
  for (const [method, path] of [
    ["GET", "/api/organization/invitations"],
    ["POST", "/api/organization/invitations"],
    ["POST", `/api/organization/invitations/${ORG}/resend`],
    ["DELETE", `/api/organization/invitations/${ORG}`],
  ] as const) {
    test(`a member is refused ${method} ${path} before any invitation is read`, async () => {
      const { request, statements } = tenantApp("member");
      const response = await request(path, { method, body: method === "POST" ? JSON.stringify({ email: "x@example.com", role: "member" }) : undefined });
      expect(response.status).toBe(403);
      expect(statements.some((sql) => sql.includes("organization_member_invitations"))).toBe(false);
    });
  }

  test("a member lists the members without the pending invitations", async () => {
    const { request, statements } = tenantApp("member");
    const response = await request("/api/organization/members");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ members: [], pendingInvitations: [], pendingInvitationsTruncated: false });
    expect(statements.some((sql) => sql.includes("organization_member_invitations"))).toBe(false);
  });

  test("an owner's invitation with a malformed address is refused before the database", async () => {
    const { request, statements } = tenantApp("owner");
    const before = statements.length;
    const response = await request("/api/organization/invitations", { method: "POST", body: JSON.stringify({ email: "not-an-address", role: "member" }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "EMAIL_INVALID" });
    expect(statements.slice(before).some((sql) => sql.includes("organization_member_invitations"))).toBe(false);
  });

  test("an invitation never targets the owner role", async () => {
    const { request } = tenantApp("admin");
    const response = await request("/api/organization/invitations", { method: "POST", body: JSON.stringify({ email: "x@example.com", role: "owner" }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "ROLE_INVALID" });
  });
});
