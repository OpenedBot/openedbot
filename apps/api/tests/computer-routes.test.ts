import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import type { ComputerProvider } from "../src/infrastructure/computer-provider";
import { ComputerProviderError } from "../src/infrastructure/computer-provider";
import { computerRoutes } from "../src/routes/roster/computer-routes";
import { HttpError } from "../src/interfaces/http/http-error";

const owner: AuthContext = {
  sessionId: "session-1",
  organizationId: "org-1",
  userId: "user-1",
  role: "owner",
  kind: "web",
  credentialHash: "credential",
};

function database(archivedAt: Date | null = null): SQL {
  const sql = ((strings: TemplateStringsArray) => {
    const query = [...strings].join(" ");
    if (query.includes("from bots")) return Promise.resolve([{ id: "bot-1", name: "Scout", archivedAt }]);
    return Promise.resolve([]);
  }) as unknown as SQL;
  (sql as unknown as { begin: (callback: (tx: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback) => callback(sql);
  return sql;
}

function mount(provider: ComputerProvider, auth: AuthContext = owner, db = database()) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED" } }, 500));
  app.route("/", computerRoutes(db, provider));
  return app;
}

function fakeProvider(overrides: Partial<ComputerProvider> = {}): ComputerProvider {
  return {
    kind: "box",
    status: async () => ({ configured: true, state: "off", providerState: null }),
    start: async () => ({ configured: true, state: "ready", providerState: "ready" }),
    open: async () => ({ url: "https://desktop.example/session" }),
    capture: async () => ({ mediaType: "image/jpeg", base64: "/9j/2Q==", capturedAt: "2026-08-26T12:00:00.000Z" }),
    stop: async () => ({ configured: true, state: "off", providerState: "stopping" }),
    ...overrides,
  };
}

describe("bot Computer routes", () => {
  test("publishes a truthful disabled capability with no viewer or capture", async () => {
    const provider = fakeProvider({
      kind: "disabled",
      status: async () => ({ configured: false, state: "off", providerState: null }),
    });
    const response = await mount(provider).request("/bot-1/computer");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      botId: "bot-1",
      canManage: true,
      provider: null,
      observation: { capability: { supported: false, reason: "COMPUTER_CAPABILITY_UNSUPPORTED" } },
      agentControl: { status: "unavailable", reason: "COMPUTER_PROVIDER_DISABLED" },
      providerState: null,
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("scopes lifecycle calls to the authenticated tenant and bot", async () => {
    const calls: string[] = [];
    const provider = fakeProvider({
      start: async (key, name) => {
        calls.push(`${key}|${name}`);
        return { configured: true, state: "ready", providerState: "idle" };
      },
    });
    const response = await mount(provider).request("/bot-1/computer/start", { method: "POST" });
    expect(response.status).toBe(200);
    expect(calls).toEqual(["org-1:bot-1|Scout"]);
    expect(await response.json()).toMatchObject({
      provider: "box",
      observation: {
        capability: { supported: true, canOpen: true, canCapture: true },
        status: { status: "ready" },
      },
      agentControl: {
        status: "unavailable",
        reason: "COMPUTER_AGENT_CONTROL_NOT_BOUND",
      },
    });
  });

  test("takes the tenant+bot advisory lock before a lifecycle mutation", async () => {
    const calls: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      const query = [...strings].join(" ");
      calls.push(query.includes("pg_advisory_xact_lock") ? "lock" : query.includes("from bots") ? "bot" : "sql");
      if (query.includes("from bots")) {
        return Promise.resolve([{ id: "bot-1", name: "Scout", archivedAt: null }]);
      }
      return Promise.resolve([]);
    }) as unknown as SQL;
    (sql as unknown as { begin: (callback: (tx: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback) => callback(sql);
    const provider = fakeProvider({
      stop: async () => {
        calls.push("provider.stop");
        return { configured: true, state: "off", providerState: "archived" };
      },
    });

    const response = await mount(provider, owner, sql).request("/bot-1/computer/stop", { method: "POST" });
    expect(response.status).toBe(200);
    expect(calls.indexOf("lock")).toBeGreaterThan(calls.indexOf("bot"));
    expect(calls.indexOf("provider.stop")).toBeGreaterThan(calls.indexOf("lock"));
  });

  test("requires owner or admin before every sensitive Computer mutation", async () => {
    const calls: string[] = [];
    const provider = fakeProvider({
      start: async () => {
        calls.push("start");
        return { configured: true, state: "ready", providerState: "ready" };
      },
      open: async () => {
        calls.push("open");
        return { url: "https://desktop.example/session" };
      },
      capture: async () => {
        calls.push("capture");
        return { mediaType: "image/jpeg", base64: "/9j/2Q==", capturedAt: "2026-08-26T12:00:00.000Z" };
      },
      stop: async () => {
        calls.push("stop");
        return { configured: true, state: "off", providerState: "stopping" };
      },
    });
    const member = { ...owner, role: "member" as const };
    for (const action of ["start", "open", "capture", "stop"]) {
      const response = await mount(provider, member).request(`/bot-1/computer/${action}`, { method: "POST" });
      expect(response.status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  test("publishes read-only management capability from the authenticated role", async () => {
    const member = { ...owner, role: "member" as const };
    const response = await mount(fakeProvider(), member).request("/bot-1/computer");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ botId: "bot-1", canManage: false });
  });

  test("refuses to start an archived bot before contacting the provider", async () => {
    let called = false;
    const provider = fakeProvider({ start: async () => {
      called = true;
      return { configured: true, state: "ready", providerState: "ready" };
    } });
    const response = await mount(provider, owner, database(new Date())).request("/bot-1/computer/start", { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "BOT_ARCHIVED" } });
    expect(called).toBe(false);
  });

  test("never forwards raw provider errors or credentials to the client", async () => {
    const provider = fakeProvider({
      capture: async () => {
        throw new ComputerProviderError(502, "COMPUTER_CAPTURE_FAILED", "La capture du bureau a échoué.");
      },
    });
    const response = await mount(provider).request("/bot-1/computer/capture", { method: "POST" });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("COMPUTER_CAPTURE_FAILED");
    expect(body).not.toContain("box_");
  });
});
