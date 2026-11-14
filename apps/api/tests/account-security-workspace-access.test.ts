import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { EMPTY_WORKSPACE_ID } from "@openedbot/identity/domain/workspace-access";
import { hashCredential } from "../src/infrastructure/crypto";
import { authMiddleware, type AppVariables } from "../src/routes/identity/auth";
import { accountSecurityRoutes } from "../src/routes/identity/account-security-routes";
import { accountDeletionWriteGuard } from "../src/routes/identity/account-deletion-routes";

const ORG = "84000000-0000-4000-8000-000000000001";
const ROOT = "/api/account/security";
const USER = "user-own";
const CURRENT = "session-current";
const OTHER = "session-other";
const FOREIGN = "session-foreign";
const CSRF = "test-csrf";

type Session = { kind: "web" | "native"; organizationId: string | null; assistance?: boolean };

/** Real middleware, guard, routes and identity SQL; only the database boundary is replaced. */
function fixture(session: Session) {
  const revoked: string[] = [];
  let authenticatingUser: unknown;
  let securityReads = 0;
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ? ").replace(/\s+/g, " ").trim();
    if (sql.includes("set_config('app.authenticating_user_id'")) {
      authenticatingUser = values[0];
      return [];
    }
    if (sql.includes("set_config('app.session_credential_hash'") || sql.includes("set_config('app.organization_id'")) return [];
    if (sql.startsWith("select s.id,")) return [{
      id: CURRENT, userId: USER, ...session, csrfHash: hashCredential(CSRF),
      assistedBy: session.assistance ? "staff-1" : null,
    }];
    if (sql.startsWith("update sessions set last_seen_at")) return [];
    if (sql.includes("from workspace_access(")) return [];
    if (sql.includes('as "hasPassword"')) {
      expect(values).toEqual([USER]);
      securityReads += 1;
      return [{ email: "own@example.com", hasPassword: false, hasGoogle: true, mustChangePassword: false }];
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      expect(values).toEqual([USER]);
      return [];
    }
    if (sql.includes("from sessions") || sql.startsWith("update sessions")) {
      expect(authenticatingUser).toBe(USER);
      expect(sql).toContain("user_id = ?");
      expect(sql).toContain("impersonated_by_staff_user_id is null");
      if (sql.startsWith("select id, kind,")) {
        expect(values).toEqual([USER]);
        return [CURRENT, OTHER].map((id) => ({ id, kind: "web", createdAt: new Date(), lastSeenAt: new Date(),
          expiresAt: new Date(), revokedAt: null, revokedReason: null, userAgent: null, ip: null }));
      }
      expect(sql).toContain("revoked_reason = 'user_revoked'");
      if (sql.includes("id <>")) {
        expect(values).toEqual([USER, CURRENT]);
      } else {
        expect(values).toEqual([USER, values[1], values[1], USER]);
        if (values[1] !== OTHER) return [];
      }
      if (revoked.includes(OTHER)) return [];
      revoked.push(OTHER);
      return [{ id: OTHER }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }) as unknown as SQL;
  db.begin = (async (callback: (tx: SQL) => Promise<unknown>) => {
    authenticatingUser = undefined;
    try { return await callback(db); } finally { authenticatingUser = undefined; }
  }) as SQL["begin"];
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError((error, c) => error instanceof HttpError
    ? c.json({ code: error.code }, error.status as 403)
    : c.json({ code: "UNEXPECTED", message: String(error) }, 500));
  app.use("*", authMiddleware(db));
  app.use("*", async (c, next) => {
    expect(c.get("auth").organizationId).toBe(EMPTY_WORKSPACE_ID);
    await next();
  });
  app.use("*", accountDeletionWriteGuard(db));
  app.route(ROOT, accountSecurityRoutes(db));
  // If an unlisted route slips through authentication, it must visibly fail this test.
  app.all("*", (c) => c.json({ reached: true }));
  const request = (path: string, method = "GET", csrf: string | null = CSRF) => app.request(path, {
    method,
    headers: session.kind === "native" ? { Authorization: "Bearer access" }
      : { Cookie: "openedbot_session=web", ...(csrf === null ? {} : { "X-CSRF-Token": csrf }) },
  });
  return { request, revoked, securityReads: () => securityReads };
}

const contexts: Session[] = [
  { kind: "web", organizationId: null },
  { kind: "native", organizationId: null },
  { kind: "web", organizationId: ORG },
];

describe("account sessions without workspace access", () => {
  for (const session of contexts) {
    test(`${session.kind}, organization=${session.organizationId}: lists and revokes only own sessions`, async () => {
      const f = fixture(session);
      const list = await f.request(ROOT);
      expect(list.status).toBe(200);
      const body = await list.json();
      expect(body.sessions.map((s: { id: string }) => s.id)).toEqual([CURRENT, OTHER]);
      expect(body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      expect((await f.request(`${ROOT}/sessions/${FOREIGN}`, "DELETE")).status).toBe(404);
      expect(f.revoked).toEqual([]);
      expect((await f.request(`${ROOT}/sessions/${CURRENT}`, "DELETE")).status).toBe(409);
      expect((await f.request(`${ROOT}/sessions/${OTHER}`, "DELETE")).status).toBe(204);
      const remaining = fixture(session);
      const others = await remaining.request(`${ROOT}/sessions/revoke-others`, "POST");
      expect(others.status).toBe(200);
      expect(await others.json()).toEqual({ revoked: 1 });
      expect(f.revoked).toEqual([OTHER]);
      expect(remaining.revoked).toEqual([OTHER]);
      expect(await (await remaining.request(`${ROOT}/sessions/revoke-others`, "POST")).json()).toEqual({ revoked: 0 });
    });

    test(`${session.kind}, organization=${session.organizationId}: tenant and unlisted security routes stay closed`, async () => {
      const f = fixture(session);
      for (const [path, method] of [
        ["/api/bots", "GET"], ["/api/account/deletion", "DELETE"],
        [ROOT, "POST"], [`${ROOT}-extra`, "GET"], [`${ROOT}/password`, "POST"],
        [`${ROOT}/google/link/start`, "POST"], [`${ROOT}/sessions`, "GET"],
        [`${ROOT}/sessions-extra`, "DELETE"], [`${ROOT}/sessions/id/extra`, "DELETE"],
        [`${ROOT}/sessions/id`, "POST"], [`${ROOT}/sessions/revoke-others-extra`, "POST"],
      ]) {
        const response = await f.request(path!, method!);
        expect([path, response.status]).toEqual([path, 403]);
        expect((await response.json()).code).toBe("WORKSPACE_ACCESS_REVOKED");
      }
      expect(f.revoked).toEqual([]);
      expect(f.securityReads()).toBe(0);
    });
  }

  test("closure stays reachable without a workspace, including a native session whose workspace was revoked", async () => {
    for (const session of [...contexts, { kind: "native" as const, organizationId: ORG }]) {
      const f = fixture(session);
      for (const [path, method] of [["/api/account/deletion", "GET"], ["/api/account/deletion", "POST"], ["/api/account/deletion/cancel", "POST"]]) {
        expect((await f.request(path!, method!)).status).toBe(200);
      }
    }
    const assistance = fixture({ kind: "web", organizationId: ORG, assistance: true });
    expect((await assistance.request("/api/account/deletion", "POST")).status).toBe(403);
    expect((await fixture(contexts[0]!).request("/api/account/deletion", "POST", null)).status).toBe(403);
  });

  test("web mutations still require the correct CSRF token", async () => {
    for (const csrf of [null, "wrong-csrf"]) {
      const f = fixture({ kind: "web", organizationId: null });
      for (const [path, method] of [[`${ROOT}/sessions/${OTHER}`, "DELETE"], [`${ROOT}/sessions/revoke-others`, "POST"]]) {
        const response = await f.request(path!, method!, csrf);
        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe("CSRF_INVALID");
      }
      expect(f.revoked).toEqual([]);
    }
  });

  test("assistance cannot read or revoke the account's sessions", async () => {
    const f = fixture({ kind: "web", organizationId: ORG, assistance: true });
    for (const [path, method] of [[ROOT, "GET"], [`${ROOT}/sessions/${OTHER}`, "DELETE"], [`${ROOT}/sessions/revoke-others`, "POST"]]) {
      const response = await f.request(path!, method!);
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("IMPERSONATION_READ_ONLY");
    }
    expect(f.revoked).toEqual([]);
    expect(f.securityReads()).toBe(0);
  });

  test("native sessions pinned to a revoked workspace remain refused", async () => {
    const f = fixture({ kind: "native", organizationId: ORG });
    for (const [path, method] of [[ROOT, "GET"], [`${ROOT}/sessions/${OTHER}`, "DELETE"], [`${ROOT}/sessions/revoke-others`, "POST"]]) {
      const response = await f.request(path!, method!);
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("WORKSPACE_ACCESS_REVOKED");
    }
    expect(f.revoked).toEqual([]);
  });
});
