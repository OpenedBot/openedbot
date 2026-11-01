import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables } from "../src/routes/identity/auth";
import { API_RATE_RULES, createRateLimitGate, rateLimiter } from "../src/interfaces/http/rate-limit";
import { AUTH_EMAIL_CODE_BUDGET } from "@openedbot/platform-config/rate-limit";

function app() {
  const hono = new Hono<{ Variables: AppVariables }>();
  // trustProxy: en test on route l'IP via X-Forwarded-For (pas de socket réelle).
  hono.use(
    "/api/auth/*",
    rateLimiter({ "POST /api/auth/login": { windowMs: 60_000, max: 3 } }, { trustProxy: true }),
  );
  hono.post("/api/auth/login", (context) => context.json({ ok: true }));
  hono.post("/api/auth/register", (context) => context.json({ ok: true }));
  return hono;
}

const call = (hono: ReturnType<typeof app>, path: string, ip = "1.2.3.4") =>
  hono.request(path, { method: "POST", headers: { "x-forwarded-for": ip } });
const callWithMethod = (hono: Hono<{ Variables: AppVariables }>, path: string, method: "GET" | "POST") =>
  hono.request(path, { method, headers: { "x-forwarded-for": "1.2.3.4" } });

describe("rate limiter", () => {
  test("laisse passer jusqu'au seuil puis renvoie 429 avec Retry-After", async () => {
    const hono = app();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await call(hono, "/api/auth/login")).status).toBe(200);
    }
    const blocked = await call(hono, "/api/auth/login");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    const payload = (await blocked.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("RATE_LIMITED");
  });

  test("compte par IP: une autre IP n'est pas pénalisée", async () => {
    const hono = app();
    for (let attempt = 0; attempt < 4; attempt += 1) await call(hono, "/api/auth/login", "9.9.9.9");
    expect((await call(hono, "/api/auth/login", "5.5.5.5")).status).toBe(200);
  });

  test("n'applique aucune limite aux routes non déclarées", async () => {
    const hono = app();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await call(hono, "/api/auth/register")).status).toBe(200);
    }
  });

  test("sans proxy de confiance, un X-Forwarded-For falsifié tournant ne contourne pas la limite", async () => {
    // trustProxy par défaut = false → XFF ignoré, IP = socket (ici "unknown", bucket unique).
    const hono = new Hono<{ Variables: AppVariables }>();
    hono.use("/api/auth/*", rateLimiter({ "POST /api/auth/login": { windowMs: 60_000, max: 3 } }));
    hono.post("/api/auth/login", (context) => context.json({ ok: true }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await call(hono, "/api/auth/login", `10.0.0.${attempt}`)).status).toBe(200);
    }
    // IP spoofée différente à chaque fois: doit quand même être bloqué.
    expect((await call(hono, "/api/auth/login", "203.0.113.99")).status).toBe(429);
  });

  test("couvre les écritures paramétrées et SSE avec les règles API", async () => {
    const hono = new Hono<{ Variables: AppVariables }>();
    hono.use("/api/*", rateLimiter({
      "POST /api/*": { windowMs: 60_000, max: 2 },
      "GET /api/events*": { windowMs: 60_000, max: 2 },
    }, { trustProxy: true }));
    hono.post("/api/threads/thread-1/messages", (context) => context.json({ ok: true }));
    hono.get("/api/events/", (context) => context.body(null, 204));

    expect((await call(hono, "/api/threads/thread-1/messages")).status).toBe(200);
    expect((await call(hono, "/api/threads/thread-1/messages")).status).toBe(200);
    expect((await call(hono, "/api/threads/thread-1/messages")).status).toBe(429);
    expect((await callWithMethod(hono, "/api/events/", "GET")).status).toBe(204);
    expect((await callWithMethod(hono, "/api/events/", "GET")).status).toBe(204);
    expect((await callWithMethod(hono, "/api/events/", "GET")).status).toBe(429);
  });

  test("ne permet pas de contourner une écriture wildcard en changeant l'identifiant", async () => {
    const hono = new Hono<{ Variables: AppVariables }>();
    hono.use("/api/*", rateLimiter({ "POST /api/*": { windowMs: 60_000, max: 2 } }, { trustProxy: true }));
    hono.post("/api/threads/:threadId/messages", (context) => context.json({ ok: true }));
    expect((await call(hono, "/api/threads/a/messages")).status).toBe(200);
    expect((await call(hono, "/api/threads/b/messages")).status).toBe(200);
    expect((await call(hono, "/api/threads/c/messages")).status).toBe(429);
  });

  test("POST /api/threads/*/read a sa propre fenêtre, déclarée avant le joker POST /api/*", async () => {
    expect(API_RATE_RULES["POST /api/threads/*/read"]).toEqual({ windowMs: 60_000, max: 300 });
    const keys = Object.keys(API_RATE_RULES);
    expect(keys.indexOf("POST /api/threads/*/read")).toBeLessThan(keys.indexOf("POST /api/*"));
    const hono = new Hono<{ Variables: AppVariables }>();
    hono.use("/api/*", rateLimiter(API_RATE_RULES, { trustProxy: true }));
    hono.post("/api/threads/:threadId/read", (context) => context.body(null, 204));
    hono.post("/api/threads/:threadId/messages", (context) => context.json({ ok: true }));
    for (let attempt = 0; attempt < 61; attempt += 1) {
      expect((await call(hono, "/api/threads/t1/read")).status).toBe(204);
    }
    expect((await call(hono, "/api/threads/t1/messages")).status).toBe(200);
  });

  test("les écritures authentifiées génériques tolèrent un opérateur actif", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(API_RATE_RULES[`${method} /api/*`]?.max).toBe(300);
    }
    expect(API_RATE_RULES["POST /api/account/security/password"]).toEqual({ windowMs: 60_000, max: 5 });
  });

  test("les règles de production incluent login, écritures et SSE", () => {
    // Each code-issuing door keeps its own limit (production's passwordless
    // /login/code stays at 5) and draws on the shared issuance budget.
    expect(API_RATE_RULES["POST /api/auth/login/code"]).toEqual({ windowMs: 60_000, max: 5, shared: AUTH_EMAIL_CODE_BUDGET });
    expect(API_RATE_RULES["POST /api/auth/login"]).toEqual({ windowMs: 60_000, max: 10, shared: AUTH_EMAIL_CODE_BUDGET });
    expect(API_RATE_RULES["POST /api/auth/native/authorize"]).toEqual({ windowMs: 60_000, max: 20, shared: AUTH_EMAIL_CODE_BUDGET });
    expect(AUTH_EMAIL_CODE_BUDGET).toEqual({ name: "auth-email-code", windowMs: 60_000, max: 10 });
    expect(API_RATE_RULES["POST /api/hooks/*"]?.max).toBe(10);
    expect(API_RATE_RULES["POST /api/*"]?.max).toBeGreaterThan(0);
    expect(API_RATE_RULES["GET /api/events*"]?.max).toBeGreaterThan(0);
  });

  test("POST /api/account/security/password est plafonné à 5/60s, la règle exacte gagne sur le joker POST /api/*", async () => {
    expect(API_RATE_RULES["POST /api/account/security/password"]).toEqual({ windowMs: 60_000, max: 5 });
    const hono = new Hono<{ Variables: AppVariables }>();
    hono.use("/api/*", rateLimiter(API_RATE_RULES, { trustProxy: true }));
    hono.post("/api/account/security/password", (context) => context.json({ ok: true }));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await call(hono, "/api/account/security/password")).status).toBe(200);
    }
    // Le joker POST /api/* autorise 300/min : sans la règle exacte, la 6e passerait.
    expect((await call(hono, "/api/account/security/password")).status).toBe(429);
  });

  test("les révocations de session ont leur propre plafond", () => {
    expect(API_RATE_RULES["POST /api/account/security/sessions/revoke-others"]).toEqual({ windowMs: 60_000, max: 10 });
    expect(API_RATE_RULES["DELETE /api/account/security/sessions/*"]).toEqual({ windowMs: 60_000, max: 20 });
  });

  test("le backoffice garde ses limites de connexion sous /api/pro/staff", () => {
    expect(API_RATE_RULES["POST /api/pro/staff/login"]).toEqual({ windowMs: 60_000, max: 10 });
    expect(API_RATE_RULES["POST /api/pro/staff/login/code"]).toEqual({ windowMs: 60_000, max: 5 });
    expect(Object.keys(API_RATE_RULES).some((key) => key.includes(" /api/staff"))).toBe(false);
  });

  test("/login/code garde son plafond de 5 même avec le budget partagé", async () => {
    const hono = new Hono<{ Variables: AppVariables }>();
    hono.use("/api/auth/*", rateLimiter(API_RATE_RULES, { trustProxy: true }));
    hono.post("/api/auth/login/code", (context) => context.json({ ok: true }));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await call(hono, "/api/auth/login/code")).status).toBe(200);
    }
    expect((await call(hono, "/api/auth/login/code")).status).toBe(429);
  });

  test("les trois portes de connexion partagent un budget de dix requêtes par IP", async () => {
    const hono = new Hono<{ Variables: AppVariables }>();
    hono.use("/api/auth/*", rateLimiter(API_RATE_RULES, { trustProxy: true }));
    for (const path of ["/api/auth/login/code", "/api/auth/login", "/api/auth/native/authorize"]) {
      hono.post(path, (context) => context.json({ ok: true }));
    }
    const paths = ["/api/auth/login/code", "/api/auth/login", "/api/auth/native/authorize"];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await call(hono, paths[attempt % paths.length]!)).status).toBe(200);
    }
    expect((await call(hono, paths[1]!)).status).toBe(429);
  });

  test("refuse un même budget partagé déclaré avec deux fenêtres", () => {
    expect(() => createRateLimitGate({
      "POST /one": { windowMs: 60_000, max: 10, shared: { name: "shared", windowMs: 60_000, max: 10 } },
      "POST /two": { windowMs: 60_000, max: 10, shared: { name: "shared", windowMs: 30_000, max: 10 } },
    })).toThrow("mismatched windows");
  });
});
