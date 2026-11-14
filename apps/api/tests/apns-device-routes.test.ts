import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import { secretEncryptionKey } from "@openedbot/hermes/secrets";
import { protectedAuthRoutes, type AppVariables, type AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { apnsDeviceRoutes } from "../src/routes/notifications/apns-device-routes";

/**
 * HTTP shell of DEV-308 without PostgreSQL: validation, configuration gate,
 * role gate and the logout hook. Registration, collisions and RLS against a
 * real database: tests/integration/apns-push.ts.
 */

const auth: AuthContext = {
  sessionId: "session-1",
  organizationId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  role: "member",
  kind: "native",
  credentialHash: "credential",
};

const keyring = { current: secretEncryptionKey(new Uint8Array(32).fill(7)), previous: [] };
const TOKEN = "ab".repeat(32);
const INSTALLATION = "6F1C2B9A-1D2E-4F00-9A11-2B3C4D5E6F70";

function fakeDb(calls: string[]): SQL {
  const query = ((strings: TemplateStringsArray) => {
    calls.push([...strings].join(" ").replace(/\s+/g, " ").trim());
    return Promise.resolve([]);
  }) as unknown as SQL;
  (query as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback) => callback(query);
  return query;
}

function mount(
  db: SQL,
  options: { authContext?: AuthContext; apns?: { bundleIds: string[] } | null } = {},
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", options.authContext ?? auth);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/api/push/apns", apnsDeviceRoutes(db, {
    apns: options.apns === undefined ? { bundleIds: ["app.openedbot.mobile"] } : options.apns,
    tokenEncryption: keyring,
  }));
  app.route("/api/auth", protectedAuthRoutes(db));
  return app;
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe("GET /api/push/apns/config", () => {
  test("says enabled only when the deployment carries an APNs key", async () => {
    const on = await mount(fakeDb([])).request("/api/push/apns/config");
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ enabled: true });
    expect(on.headers.get("cache-control")).toBe("no-store");
    const off = await mount(fakeDb([]), { apns: null }).request("/api/push/apns/config");
    expect(await off.json()).toEqual({ enabled: false });
  });
});

describe("PUT /api/push/apns/devices/:installationId", () => {
  const put = (app: Hono<{ Variables: AppVariables }>, body: unknown, installation = INSTALLATION) =>
    app.request(`/api/push/apns/devices/${installation}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  test("without APNs configuration: 404 APNS_NOT_CONFIGURED, nothing written", async () => {
    const calls: string[] = [];
    const response = await put(mount(fakeDb(calls), { apns: null }), { token: TOKEN, bundleId: "app.openedbot.mobile", environment: "sandbox" });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("APNS_NOT_CONFIGURED");
    expect(calls).toEqual([]);
  });

  test("refuses a bad token, a foreign bundle, a bad environment and a bad installation id before any SQL", async () => {
    const calls: string[] = [];
    const app = mount(fakeDb(calls));
    expect(await errorCode(await put(app, { token: "nope", bundleId: "app.openedbot.mobile", environment: "sandbox" })))
      .toBe("APNS_TOKEN_INVALID");
    expect(await errorCode(await put(app, { token: TOKEN, bundleId: "com.other.app", environment: "sandbox" })))
      .toBe("APNS_BUNDLE_ID_NOT_ALLOWED");
    expect(await errorCode(await put(app, { token: TOKEN, bundleId: "app.openedbot.mobile", environment: "dev" })))
      .toBe("VALIDATION_ERROR");
    expect(await errorCode(await put(app, { token: TOKEN, bundleId: "app.openedbot.mobile", environment: "sandbox" }, "bad%20id")))
      .toBe("VALIDATION_ERROR");
    expect(await errorCode(await put(app, "{not json"))).toBe("INVALID_JSON");
    expect(calls).toEqual([]);
  });

  test("the token is encrypted before it reaches SQL and never echoed", async () => {
    const calls: string[] = [];
    // The fake answers no row: the insert reports its failure as a 500, which
    // is enough to observe what was sent to the database.
    const response = await put(mount(fakeDb(calls)), { token: TOKEN, bundleId: "app.openedbot.mobile", environment: "production" });
    expect(response.status).toBe(500);
    expect(calls.some((sql) => sql.startsWith("insert into apns_devices"))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
    expect(await response.text()).not.toContain(TOKEN);
  });
});

describe("GET and DELETE /api/push/apns/devices/:installationId", () => {
  test("GET of an unknown installation is 404 APNS_DEVICE_NOT_FOUND", async () => {
    const response = await mount(fakeDb([])).request(`/api/push/apns/devices/${INSTALLATION}`);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("APNS_DEVICE_NOT_FOUND");
  });

  test("DELETE is 204 even when the installation is already gone, configured or not", async () => {
    for (const apns of [{ bundleIds: ["app.openedbot.mobile"] }, null]) {
      const calls: string[] = [];
      const response = await mount(fakeDb(calls), { apns }).request(`/api/push/apns/devices/${INSTALLATION}`, { method: "DELETE" });
      expect(response.status).toBe(204);
      expect(calls.some((sql) => sql.startsWith("delete from apns_devices"))).toBe(true);
    }
  });
});

describe("POST /api/auth/logout with an installation", () => {
  const logout = (app: Hono<{ Variables: AppVariables }>, body?: string) => app.request("/api/auth/logout", {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body }),
  });

  test("revokes the installation's device before the session", async () => {
    const calls: string[] = [];
    const response = await logout(mount(fakeDb(calls)), JSON.stringify({ installationId: INSTALLATION }));
    expect(response.status).toBe(204);
    const device = calls.findIndex((sql) => sql.startsWith("delete from apns_devices"));
    const session = calls.findIndex((sql) => sql.startsWith("update sessions set revoked_at"));
    expect(device).toBeGreaterThanOrEqual(0);
    expect(session).toBeGreaterThan(device);
  });

  test("no body, or a body without installationId, logs out as before", async () => {
    for (const body of [undefined, "", "{}"]) {
      const calls: string[] = [];
      expect((await logout(mount(fakeDb(calls)), body)).status).toBe(204);
      expect(calls.some((sql) => sql.startsWith("delete from apns_devices"))).toBe(false);
      expect(calls.some((sql) => sql.startsWith("update sessions set revoked_at"))).toBe(true);
    }
  });

  test("an unreadable body is refused, and the session stays", async () => {
    for (const body of ["{oops", JSON.stringify({ installationId: "../x" }), "[]"]) {
      const calls: string[] = [];
      const response = await logout(mount(fakeDb(calls)), body);
      expect(response.status).toBe(400);
      expect(calls.some((sql) => sql.startsWith("update sessions set revoked_at"))).toBe(false);
    }
  });

  test("an assistance session never removes the member's device", async () => {
    const calls: string[] = [];
    const app = mount(fakeDb(calls), { authContext: { ...auth, assistedBy: "staff-1" } });
    expect((await logout(app, JSON.stringify({ installationId: INSTALLATION }))).status).toBe(204);
    expect(calls.some((sql) => sql.startsWith("delete from apns_devices"))).toBe(false);
  });
});
