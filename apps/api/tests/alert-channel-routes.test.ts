import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import { secretEncryptionKey } from "@openedbot/hermes/secrets";
import type { DiscordTransport } from "@openedbot/notifications/application/discord-transport";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { alertChannelRoutes } from "../src/routes/notifications/alert-channel-routes";

/**
 * HTTP shell of DEV-OPE2-7 without PostgreSQL: role gate, body validation and
 * the URL filter that runs before any call to Discord. Encryption, RLS and
 * deliveries against a real database: tests/integration/alert-channels.ts.
 */

const owner: AuthContext = {
  sessionId: "session-1",
  organizationId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  role: "owner",
  kind: "native",
  credentialHash: "credential",
};
const keyring = { current: secretEncryptionKey(new Uint8Array(32).fill(7)), previous: [] };
const WEBHOOK = `https://discord.com/api/webhooks/1459685375038591192/${"t".repeat(68)}`;

function fakeDb(calls: string[]): SQL {
  const query = ((strings: TemplateStringsArray) => {
    calls.push([...strings].join(" ").replace(/\s+/g, " ").trim());
    return Promise.resolve([]);
  }) as unknown as SQL;
  (query as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback) => callback(query);
  return query;
}

function mount(options: { auth?: AuthContext; calls?: string[]; discord?: string[] } = {}) {
  const discordCalls = options.discord ?? [];
  const transport: DiscordTransport = {
    inspect: async (url) => { discordCalls.push(`GET ${url}`); return { status: 404, name: null }; },
    post: async (url) => { discordCalls.push(`POST ${url}`); return { status: 204, retryAfterSeconds: null }; },
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", options.auth ?? owner);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/api/alert-channels", alertChannelRoutes(
    fakeDb(options.calls ?? []),
    { tokenEncryption: keyring, deployEnvironment: "dev" },
    transport,
  ));
  return app;
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

async function errorBody(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

describe("/api/alert-channels", () => {
  test("only owners and admins reach the routes", async () => {
    for (const role of ["member"] as const) {
      const calls: string[] = [];
      const response = await mount({ auth: { ...owner, role }, calls }).request("/api/alert-channels");
      expect(response.status).toBe(403);
      expect((await errorBody(response)).code).toBe("ROLE_REQUIRED");
      expect(calls).toEqual([]);
    }
    const admin = await mount({ auth: { ...owner, role: "admin" } }).request("/api/alert-channels");
    expect(admin.status).toBe(200);
    expect(admin.headers.get("cache-control")).toBe("no-store");
    expect(await admin.json()).toEqual({ channels: [], limit: 10 });
  });

  test("POST refuses a kind other than Discord and a non-Discord URL before calling anyone", async () => {
    const discord: string[] = [];
    const calls: string[] = [];
    const app = mount({ calls, discord });
    const kind = await app.request("/api/alert-channels", json("POST", { kind: "slack", webhookUrl: WEBHOOK }));
    expect(kind.status).toBe(400);
    expect((await errorBody(kind)).code).toBe("ALERT_CHANNEL_KIND_INVALID");
    const internal = await app.request("/api/alert-channels", json("POST", { kind: "discord", webhookUrl: "http://169.254.169.254/latest" }));
    expect(internal.status).toBe(400);
    expect((await errorBody(internal)).code).toBe("ALERT_CHANNEL_URL_INVALID");
    const array = await app.request("/api/alert-channels", json("POST", [WEBHOOK]));
    expect(array.status).toBe(400);
    expect(discord).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("POST says when Discord does not know the webhook, without echoing the URL", async () => {
    const discord: string[] = [];
    const response = await mount({ discord }).request("/api/alert-channels", json("POST", { kind: "discord", webhookUrl: WEBHOOK }));
    expect(response.status).toBe(422);
    const body = await errorBody(response);
    expect(body.code).toBe("ALERT_CHANNEL_WEBHOOK_NOT_FOUND");
    expect(body.message).not.toContain("t".repeat(20));
    expect(discord).toEqual([`GET ${WEBHOOK}`]);
  });

  test("ids and patches are validated", async () => {
    const app = mount();
    expect((await app.request("/api/alert-channels/nope", { method: "DELETE" })).status).toBe(400);
    const empty = await app.request(`/api/alert-channels/${owner.userId}`, json("PATCH", {}));
    expect(empty.status).toBe(400);
    expect((await errorBody(empty)).code).toBe("ALERT_CHANNEL_UPDATE_INVALID");
    const wrong = await app.request(`/api/alert-channels/${owner.userId}`, json("PATCH", { enabled: "yes" }));
    expect(wrong.status).toBe(400);
    const missing = await app.request(`/api/alert-channels/${owner.userId}`, { method: "DELETE" });
    expect(missing.status).toBe(404);
    const test = await app.request(`/api/alert-channels/${owner.userId}/test`, { method: "POST" });
    expect(test.status).toBe(404);
  });
});
