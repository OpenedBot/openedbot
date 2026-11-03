import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { EMPTY_WORKSPACE_ID } from "@openedbot/identity/domain/workspace-access";
import { authMiddleware, type AppVariables } from "../src/routes/identity/auth";

const ORG = "84000000-0000-4000-8000-000000000001";

/**
 * A desktop session opened by an account without an organization (0158): it
 * reaches the account routes to define one, exactly like a web session, and
 * nothing else. The session row and `workspace_access` are stubbed.
 */
function app(session: { organizationId: string | null }) {
  const db = (async (strings: TemplateStringsArray) => {
    const sql = strings.join(" ");
    if (sql.includes("select s.id,")) {
      return [{ id: "s", organizationId: session.organizationId, userId: "u", kind: "native", csrfHash: null, impersonatedByStaffUserId: null }];
    }
    // No membership anywhere: no role in any workspace.
    return [];
  }) as unknown as SQL;
  db.begin = (async (callback: (tx: SQL) => Promise<unknown>) => callback(db)) as SQL["begin"];
  const server = new Hono<{ Variables: AppVariables }>();
  server.use("*", authMiddleware(db));
  server.all("*", (c) => c.json({ organizationId: c.get("auth").organizationId, role: c.get("auth").role }));
  server.onError((error, c) => error instanceof HttpError ? c.json({ code: error.code }, error.status as 403) : c.json({ code: "ERROR" }, 500));
  return server;
}

function request(path: string, init: { method?: string; organization?: string } = {}) {
  const headers: Record<string, string> = { Authorization: "Bearer access" };
  if (init.organization) headers["X-OHB-Organization"] = init.organization;
  return new Request(`http://localhost${path}`, { method: init.method ?? "GET", headers });
}

describe("native session without an organization", () => {
  test("reaches the account routes the onboarding needs, in the empty workspace", async () => {
    for (const [path, method] of [
      ["/api/auth/me", "GET"],
      ["/api/account/workspaces", "GET"],
      ["/api/onboarding", "GET"],
      ["/api/account/organizations", "POST"],
    ] as const) {
      const response = await app({ organizationId: null }).request(request(path, { method }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ organizationId: EMPTY_WORKSPACE_ID, role: "member" });
    }
  });

  test("reaches nothing tenant-scoped", async () => {
    const response = await app({ organizationId: null }).request(request("/api/bots"));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("WORKSPACE_ACCESS_REVOKED");
  });

  test("stays pinned: a header cannot open another workspace", async () => {
    const response = await app({ organizationId: null }).request(request("/api/account/workspaces", { organization: ORG }));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("TENANT_MISMATCH");
  });

  test("a native session pinned to an organization it lost keeps being refused", async () => {
    const response = await app({ organizationId: ORG }).request(request("/api/account/workspaces"));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("WORKSPACE_ACCESS_REVOKED");
  });
});
