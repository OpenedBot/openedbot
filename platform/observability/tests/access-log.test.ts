import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  accessLogMiddleware,
  LOG_REDACT_CENSOR,
  LOG_REDACT_PATHS,
  recordErrorCode,
  REQUEST_ID_HEADER,
  requestIdOf,
} from "../src/logger";

/** Ligne d'access-log telle que le middleware la remet au logger. */
type LogLine = { level: "info" | "warn" | "error"; fields: Record<string, unknown>; message: string };

/** Logger factice : capture les lignes au lieu de les écrire sur stdout. */
function fakeLogger(lines: LogLine[]) {
  const capture = (level: LogLine["level"]) => (fields: unknown, message: string) => {
    lines.push({ level, fields: fields as Record<string, unknown>, message });
  };
  return { info: capture("info"), warn: capture("warn"), error: capture("error") } as never;
}

describe("redaction pino", () => {
  test("couvre les en-têtes porteurs de session et les champs de secret", () => {
    const paths: string[] = [...LOG_REDACT_PATHS];
    for (const path of [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.claimCode",
      "*.sessionToken",
      "*.authorization",
      "*.cookie",
    ]) {
      expect(paths).toContain(path);
    }
  });

  test("censure par un marqueur explicite, jamais par la valeur d'origine", () => {
    expect(LOG_REDACT_CENSOR).toBe("[redacted]");
  });
});

describe("access-log", () => {
  test("logue le motif de route agrégeable en plus du chemin brut", async () => {
    const lines: LogLine[] = [];
    const app = new Hono();
    app.use("*", accessLogMiddleware({ log: fakeLogger(lines) }));
    app.get("/api/bots/:botId", (context) => context.json({ ok: true }));

    const response = await app.request("/api/bots/8f1c2b3a-0000-4000-8000-000000000000");

    expect(response.status).toBe(200);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("info");
    expect(lines[0]?.fields.route).toBe("/api/bots/:botId");
    expect(lines[0]?.fields.path).toBe("/api/bots/8f1c2b3a-0000-4000-8000-000000000000");
    expect(lines[0]?.fields.method).toBe("GET");
    expect(typeof lines[0]?.fields.durationMs).toBe("number");
  });

  test("reporte l'organisation et l'utilisateur authentifiés, jamais l'email", async () => {
    const lines: LogLine[] = [];
    const app = new Hono<{ Variables: { auth: { organizationId: string; userId: string; email: string } } }>();
    app.use("*", accessLogMiddleware({ log: fakeLogger(lines) }));
    app.get("/api/me", (context) => {
      context.set("auth", { organizationId: "org-1", userId: "user-1", email: "kev@example.test" });
      return context.json({ ok: true });
    });

    await app.request("/api/me");

    expect(lines[0]?.fields.organizationId).toBe("org-1");
    expect(lines[0]?.fields.userId).toBe("user-1");
    expect(JSON.stringify(lines[0]?.fields)).not.toContain("example.test");
  });

  test("n'ajoute pas de champ d'identité sur une requête anonyme", async () => {
    const lines: LogLine[] = [];
    const app = new Hono();
    app.use("*", accessLogMiddleware({ log: fakeLogger(lines) }));
    app.get("/api/health", (context) => context.json({ ok: true }));

    await app.request("/api/health");

    expect(lines[0]?.fields).not.toHaveProperty("organizationId");
    expect(lines[0]?.fields).not.toHaveProperty("userId");
  });

  test("logue en warn au-delà de 400 et en error au-delà de 500", async () => {
    const lines: LogLine[] = [];
    const app = new Hono();
    app.use("*", accessLogMiddleware({ log: fakeLogger(lines) }));
    app.get("/boom", (context) => context.json({ error: true }, 503));

    await app.request("/absente");
    await app.request("/boom");

    expect(lines[0]?.level).toBe("warn");
    expect(lines[0]?.fields.status).toBe(404);
    expect(lines[1]?.level).toBe("error");
    expect(lines[1]?.fields.status).toBe(503);
  });

  test("corrèle l'en-tête X-Request-Id, la ligne de log et la référence du 500", async () => {
    const lines: LogLine[] = [];
    const app = new Hono();
    app.use("*", accessLogMiddleware({ log: fakeLogger(lines) }));
    app.get("/casse", () => {
      throw new Error("panne");
    });
    // Même forme que le handler `onError` de `src/index.ts`.
    app.onError((_error, context) => {
      const requestId = requestIdOf(context.req.raw);
      return context.json({ error: { code: "INTERNAL_ERROR", message: `Erreur interne. Référence : ${requestId}` } }, 500);
    });

    const response = await app.request("/casse");
    const body = (await response.json()) as { error: { message: string } };

    const header = response.headers.get(REQUEST_ID_HEADER);
    expect(header).toBeTruthy();
    expect(body.error.message).toBe(`Erreur interne. Référence : ${header}`);
    expect(lines[0]?.fields.requestId).toBe(header);
    expect(lines[0]?.level).toBe("error");
  });

  test("un identifiant distinct par requête", async () => {
    const app = new Hono();
    app.use("*", accessLogMiddleware({ log: fakeLogger([]) }));
    app.get("/", (context) => context.json({ ok: true }));

    const first = await app.request("/");
    const second = await app.request("/");

    expect(first.headers.get(REQUEST_ID_HEADER)).not.toBe(second.headers.get(REQUEST_ID_HEADER));
  });

  test("un refus métier écrit son code dans la ligne, pas seulement son statut", async () => {
    // L'écran affiche `SERVER_EXISTS` et une référence ; sans ce champ, la
    // ligne que cette référence désigne ne dit que « status 409 », et personne
    // ne peut relier les deux.
    const lines: LogLine[] = [];
    const app = new Hono();
    app.use("*", accessLogMiddleware({ log: fakeLogger(lines) }));
    app.get("/refuse", () => {
      throw new Error("refusé");
    });
    app.onError((_error, context) => {
      recordErrorCode(context.req.raw, "SERVER_EXISTS");
      return context.json({ error: { code: "SERVER_EXISTS", message: "déjà là" } }, 409);
    });

    const response = await app.request("/refuse");
    expect(response.status).toBe(409);
    expect(lines[0]?.fields.errorCode).toBe("SERVER_EXISTS");
    expect(lines[0]?.level).toBe("warn");
  });

  test("une requête qui réussit ne porte pas de code d'erreur", async () => {
    const lines: LogLine[] = [];
    const app = new Hono();
    app.use("*", accessLogMiddleware({ log: fakeLogger(lines) }));
    app.get("/", (context) => context.json({ ok: true }));

    await app.request("/");
    expect("errorCode" in (lines[0]?.fields ?? {})).toBe(false);
  });

  test("requestIdOf rend le même identifiant pour une requête donnée", () => {
    const request = new Request("http://api.test/x");
    expect(requestIdOf(request)).toBe(requestIdOf(request));
    expect(requestIdOf(new Request("http://api.test/x"))).not.toBe(requestIdOf(request));
  });
});
