import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { pushSubscriptionRoutes } from "../src/routes/notifications/push-subscription-routes";

const auth: AuthContext = {
  sessionId: "session-1",
  organizationId: "org-1",
  userId: "user-1",
  role: "member",
  kind: "web",
  credentialHash: "credential",
};

const other: AuthContext = {
  ...auth,
  organizationId: "org-2",
  userId: "user-2",
};

const VAPID = {
  publicKey: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString("base64url"),
  privateKey: Buffer.alloc(32, 9).toString("base64url"),
  subject: "mailto:ops@ohb.example",
};

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
const KEYS = { p256dh: "p256dhKeyValue012345", auth: "authKeyValue01" };

type Row = { id: string; endpoint: string; createdAt: Date; lastUsedAt: Date | null };

function mount(
  db: SQL,
  authContext: AuthContext = auth,
  vapid: (typeof VAPID & { allowLoopbackEndpoints?: boolean }) | null = VAPID,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", authContext);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/", pushSubscriptionRoutes(db, { vapid }));
  return app;
}

function fakeDb(options: {
  calls: string[];
  bindings?: unknown[][];
  existing?: Row | null;
  inserted?: Row;
  updated?: Row;
  deleted?: Array<{ id: string }>;
  count?: number;
}): SQL {
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    options.calls.push(sql);
    options.bindings?.push(values);
    if (sql.includes("set_config('app.organization_id'")) return Promise.resolve([]);
    if (sql.includes("set_config('app.authenticating_user_id'")) return Promise.resolve([]);
    if (sql.includes("select id, endpoint") && sql.includes("and endpoint =")) {
      return Promise.resolve(options.existing ? [options.existing] : []);
    }
    if (sql.includes("select id, endpoint")) {
      return Promise.resolve(options.existing ? [options.existing] : []);
    }
    if (sql.includes("select count(*)::int as count")) {
      return Promise.resolve([{ count: options.count ?? 0 }]);
    }
    if (sql.startsWith("update push_subscriptions")) {
      return Promise.resolve(options.updated ? [options.updated] : options.existing ? [options.existing] : []);
    }
    if (sql.startsWith("insert into push_subscriptions")) {
      return Promise.resolve(options.inserted ? [options.inserted] : []);
    }
    if (sql.startsWith("delete from push_subscriptions")) {
      return Promise.resolve(options.deleted ?? []);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (query as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(query);
  return query;
}

const row: Row = {
  id: "sub-1",
  endpoint: ENDPOINT,
  createdAt: new Date("2026-09-04T10:00:00.000Z"),
  lastUsedAt: null,
};

describe("GET /api/push-subscriptions/vapid-public-key", () => {
  test("rend la clé publique, jamais la privée", async () => {
    const response = await mount(fakeDb({ calls: [] })).request("/vapid-public-key");
    expect(response.status).toBe(200);
    const body = await response.json() as { publicKey: string; configured: boolean };
    expect(body.configured).toBe(true);
    expect(body.publicKey).toBe(VAPID.publicKey);
    expect(JSON.stringify(body)).not.toContain(VAPID.privateKey);
  });

  test("absent en développement : 404 PUSH_NOT_CONFIGURED", async () => {
    const response = await mount(fakeDb({ calls: [] }), auth, null).request("/vapid-public-key");
    expect(response.status).toBe(404);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("PUSH_NOT_CONFIGURED");
  });
});

describe("GET /api/push-subscriptions", () => {
  test("liste les abonnements du membre courant, bornés au tenant", async () => {
    const bindings: unknown[][] = [];
    const response = await mount(fakeDb({ calls: [], bindings, existing: row })).request("/");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      subscriptions: Array<{ id: string; endpoint: string; createdAt: string; lastUsedAt: string | null }>;
      configured: boolean;
    };
    expect(body.configured).toBe(true);
    expect(body.subscriptions).toEqual([{
      id: "sub-1",
      endpoint: ENDPOINT,
      createdAt: "2026-09-04T10:00:00.000Z",
      lastUsedAt: null,
    }]);
    expect(bindings.flat()).toContain("org-1");
    expect(bindings.flat()).toContain("user-1");
  });

  test("un autre tenant n'est jamais lu : l'organisation d'auth est la seule bindée", async () => {
    const bindings: unknown[][] = [];
    await mount(fakeDb({ calls: [], bindings }), other).request("/");
    expect(bindings.flat()).toContain("org-2");
    expect(bindings.flat()).not.toContain("org-1");
  });
});

describe("POST /api/push-subscriptions", () => {
  const payload = JSON.stringify({ endpoint: ENDPOINT, keys: KEYS, locale: "en" });

  test("crée un abonnement", async () => {
    const inserted = { ...row, lastUsedAt: null };
    const response = await mount(fakeDb({ calls: [], inserted })).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; endpoint: string };
    expect(body.id).toBe("sub-1");
    expect(body.endpoint).toBe(ENDPOINT);
  });

  test("idempotence : le même endpoint met à jour, ne duplique pas", async () => {
    const updated = { ...row, lastUsedAt: new Date("2026-09-04T11:00:00.000Z") };
    const response = await mount(fakeDb({ calls: [], existing: row, updated })).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string };
    expect(body.id).toBe("sub-1");
  });

  test("refuse un endpoint http", async () => {
    const response = await mount(fakeDb({ calls: [] })).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "http://push.example/x", keys: KEYS }),
    });
    expect(response.status).toBe(400);
  });

  test("refuse toute destination hors des services Push, sans écriture", async () => {
    for (const endpoint of [
      "https://127.0.0.1:9443/push/e2e",
      "https://localhost/push",
      "https://[::1]/push",
      "https://10.0.0.5/push",
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal/push",
      "https://push.example/sub/abc",
      "https://fcm.googleapis.com.evil.example/fcm/send/abc",
      "https://evilpush.apple.com.example/x",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user:pass@fcm.googleapis.com/fcm/send/abc",
    ]) {
      const calls: string[] = [];
      const response = await mount(fakeDb({ calls })).request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, keys: KEYS }),
      });
      expect({ endpoint, status: response.status }).toEqual({ endpoint, status: 400 });
      expect(calls).toHaveLength(0);
    }
  });

  test("accepte les services Push des navigateurs", async () => {
    for (const endpoint of [
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
      "https://web.push.apple.com/QGx",
    ]) {
      const response = await mount(fakeDb({ calls: [], inserted: { ...row, endpoint } })).request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, keys: KEYS }),
      });
      expect({ endpoint, status: response.status }).toEqual({ endpoint, status: 201 });
    }
  });

  test("boucle locale : seulement avec l'opt-in du serveur push simulé", async () => {
    const response = await mount(
      fakeDb({ calls: [], inserted: { ...row, endpoint: "https://127.0.0.1:9443/push/e2e" } }),
      auth,
      { ...VAPID, allowLoopbackEndpoints: true },
    ).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://127.0.0.1:9443/push/e2e", keys: KEYS }),
    });
    expect(response.status).toBe(201);
  });

  test("sans VAPID : 404, aucune écriture", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({ calls }), auth, null).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    expect(response.status).toBe(404);
    expect(calls.some((sql) => sql.includes("insert"))).toBe(false);
  });
});

describe("DELETE /api/push-subscriptions", () => {
  test("supprime l'abonnement du membre", async () => {
    const response = await mount(fakeDb({ calls: [], deleted: [{ id: "sub-1" }] })).request("/", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: ENDPOINT }),
    });
    expect(response.status).toBe(204);
  });

  test("inconnu : 404", async () => {
    const response = await mount(fakeDb({ calls: [], deleted: [] })).request("/", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: ENDPOINT }),
    });
    expect(response.status).toBe(404);
  });
});
