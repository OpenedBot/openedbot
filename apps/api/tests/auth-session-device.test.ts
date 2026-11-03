import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import {
  authMiddleware,
  sessionDevice,
} from "../src/routes/identity/auth";
import { recordUserLogin } from "@openedbot/identity/sql/accounts";
import { createWebSession } from "@openedbot/identity/sql/sessions";
import { hashCredential } from "../src/infrastructure/crypto";
import type { AppVariables } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";

function fakeDb(options: {
  calls: string[];
  bindings?: unknown[][];
  sessionRow?: {
    id: string;
    organizationId: string;
    userId: string;
    kind: "web" | "native";
    csrfHash: string | null;
    impersonatedByStaffUserId: string | null;
  } | null;
  role?: string;
}): SQL {
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    options.calls.push(sql);
    options.bindings?.push(values);

    if (sql.includes("select s.id,")) {
      const row = options.sessionRow === undefined
        ? {
            id: "session-1",
            organizationId: "org-1",
            userId: "user-1",
            kind: "web" as const,
            csrfHash: "csrf-hash",
            impersonatedByStaffUserId: null,
          }
        : options.sessionRow;
      return Promise.resolve(row ? [row] : []);
    }
    if (sql.includes("from workspace_access(")) {
      return Promise.resolve([{ role: options.role ?? "owner", kind: "personal", viaAgencyIds: [] }]);
    }
    if (sql.includes("insert into sessions")) {
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (query as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(query);
  return query;
}

describe("createWebSession", () => {
  test("insère user_agent et ip dans la ligne créée", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const db = fakeDb({ calls, bindings });
    const session = await createWebSession(db, "org-1", "user-1", { userAgent: "Mozilla/5.0 Test", ip: "203.0.113.7" });

    expect(session.id).toBeTruthy();
    expect(session.token).toBeTruthy();
    expect(session.csrf).toBeTruthy();

    const insertIndex = calls.findIndex((sql) => sql.includes("insert into sessions"));
    expect(insertIndex).toBeGreaterThanOrEqual(0);
    expect(calls[insertIndex]).toContain("user_agent");
    expect(calls[insertIndex]).toContain("ip");
    const inserted = bindings[insertIndex] ?? [];
    expect(inserted).toContain("Mozilla/5.0 Test");
    expect(inserted).toContain("203.0.113.7");
  });

  test("le défaut { userAgent: null, ip: null } garde les appelants compilables", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const db = fakeDb({ calls, bindings });
    await createWebSession(db, "org-1", "user-1");
    const insertIndex = calls.findIndex((sql) => sql.includes("insert into sessions"));
    const inserted = bindings[insertIndex] ?? [];
    expect(inserted).toContain(null);
  });
});

describe("recordUserLogin", () => {
  test("écrit last_login_at sur le compte, sans toucher sessions.last_seen_at", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    await recordUserLogin(fakeDb({ calls, bindings }), "user-1");

    const index = calls.findIndex((sql) => sql.includes("update users set last_login_at = now()"));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(bindings[index]).toEqual(["user-1"]);
    // La date d'entrée ne passe jamais par la table des sessions : celle-ci
    // porte l'activité, elle est purgée, et les deux ne répondent pas à la
    // même question.
    expect(calls.some((sql) => sql.includes("update sessions"))).toBe(false);
  });

  test("un échec d'écriture ne remonte pas : la connexion reste valide", async () => {
    const broken = (() => Promise.reject(new Error("deadlock detected"))) as unknown as SQL;
    // Aucun `expect(...).toThrow` : l'assertion est que l'appel se résout. Une
    // exception ici referait échouer un login par ailleurs réussi.
    await expect(recordUserLogin(broken, "user-1")).resolves.toBeUndefined();
  });
});

describe("sessionDevice", () => {
  test("ip: null quand trustProxy est faux, même avec un x-forwarded-for présent", async () => {
    const app = new Hono();
    app.get("/", (context) => context.json(sessionDevice(context, { trustProxy: false })));
    const response = await app.request("/", {
      headers: { "user-agent": "Mozilla/5.0 Test", "x-forwarded-for": "1.1.1.1, 2.2.2.2" },
    });
    const body = await response.json();
    expect(body).toEqual({ userAgent: "Mozilla/5.0 Test", ip: null });
  });

  test("le DERNIER hop de x-forwarded-for est retenu quand trustProxy est vrai", async () => {
    const app = new Hono();
    app.get("/", (context) => context.json(sessionDevice(context, { trustProxy: true })));
    const response = await app.request("/", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" },
    });
    const body = await response.json();
    expect(body.ip).toBe("10.0.0.2");
  });

  test("sans proxy de confiance, l'IP de SOCKET est retenue : celle qui remplit l'écran en local", async () => {
    const app = new Hono();
    app.get("/", (context) => context.json(sessionDevice(context, { trustProxy: false })));
    const server = { requestIP: () => ({ address: "::1" }) };
    const response = await app.fetch(
      new Request("http://localhost/", { headers: { "x-forwarded-for": "1.1.1.1" } }),
      server,
    );
    const body = await response.json();
    // Le `x-forwarded-for` du client reste ignoré : c'est la socket qui parle.
    expect(body.ip).toBe("::1");
  });

  test("avec un proxy de confiance, le hop l'emporte sur la socket", async () => {
    const app = new Hono();
    app.get("/", (context) => context.json(sessionDevice(context, { trustProxy: true })));
    const server = { requestIP: () => ({ address: "10.0.0.9" }) };
    const response = await app.fetch(
      new Request("http://localhost/", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } }),
      server,
    );
    const body = await response.json();
    expect(body.ip).toBe("10.0.0.1");
  });

  test("ni proxy ni socket exposée : ip null, jamais la chaîne \"unknown\" dans une colonne inet", async () => {
    const app = new Hono();
    app.get("/", (context) => context.json(sessionDevice(context, { trustProxy: false })));
    const response = await app.request("/");
    const body = await response.json();
    expect(body.ip).toBeNull();
  });

  test("user-agent tronqué à 256 caractères", async () => {
    const app = new Hono();
    app.get("/", (context) => context.json(sessionDevice(context, { trustProxy: false })));
    const long = "A".repeat(400);
    const response = await app.request("/", { headers: { "user-agent": long } });
    const body = await response.json();
    expect((body.userAgent as string).length).toBe(256);
  });

  test("aucun en-tête -> userAgent et ip null", async () => {
    const app = new Hono();
    app.get("/", (context) => context.json(sessionDevice(context, { trustProxy: true })));
    const response = await app.request("/");
    const body = await response.json();
    expect(body).toEqual({ userAgent: null, ip: null });
  });
});

describe("authMiddleware : rafraîchissement de last_seen_at", () => {
  function mount(db: SQL): Hono<{ Variables: AppVariables }> {
    const app = new Hono<{ Variables: AppVariables }>();
    app.onError((error, context) => error instanceof HttpError
      ? context.json({ error: { code: error.code } }, error.status as 400)
      : context.json({ error: { code: "UNEXPECTED" } }, 500));
    app.use("*", authMiddleware(db));
    app.get("/whoami", (context) => context.json({ auth: context.get("auth") }));
    app.post("/mutate", (context) => context.json({ ok: true }));
    app.post("/api/auth/logout", (context) => context.body(null, 204));
    return app;
  }

  test("émet l'update last_seen_at avec le garde interval '60 seconds'", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({ calls })).request("/whoami", {
      headers: { Cookie: "ohb_session=some-session-token" },
    });
    expect(response.status).toBe(200);
    const refreshCall = calls.find((sql) => sql.includes("update sessions set last_seen_at = now()"));
    expect(refreshCall).toBeDefined();
    expect(refreshCall).toContain("interval '60 seconds'");
  });

  test("session inconnue : pas de refus caché, 401 SESSION_EXPIRED", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({ calls, sessionRow: null })).request("/whoami", {
      headers: { Cookie: "ohb_session=unknown-token" },
    });
    expect(response.status).toBe(401);
  });

  test("une session d'assistance refuse toute écriture métier", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({
      calls,
      sessionRow: {
        id: "session-1",
        organizationId: "org-1",
        userId: "user-1",
        kind: "web",
        csrfHash: hashCredential("csrf-token"),
        impersonatedByStaffUserId: "staff-1",
      },
    })).request("/mutate", {
      method: "POST",
      headers: { Cookie: "ohb_session=session-token", "X-CSRF-Token": "csrf-token" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "IMPERSONATION_READ_ONLY" } });
  });

  test("une session d'assistance peut se déconnecter", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({
      calls,
      sessionRow: {
        id: "session-1",
        organizationId: "org-1",
        userId: "user-1",
        kind: "web",
        csrfHash: hashCredential("csrf-token"),
        impersonatedByStaffUserId: "staff-1",
      },
    })).request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: "ohb_session=session-token", "X-CSRF-Token": "csrf-token" },
    });
    expect(response.status).toBe(204);
  });
});
