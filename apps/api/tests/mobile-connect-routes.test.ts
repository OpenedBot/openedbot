import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { readApiConfig } from "../src/infrastructure/config";
import {
  MOBILE_CONNECT_TICKET_TTL_MS,
  mobileConnectJoinUrl,
  mobileConnectProtectedRoutes,
  mobileConnectRoutes,
  parseMobileConnectTicket,
} from "../src/routes/identity/mobile-connect-routes";

/**
 * Coque HTTP de Mobile Connect sans PostgreSQL : forme du lien, validation du
 * ticket, usage unique, expiration, et le secret qui ne touche jamais la base.
 */

const auth: AuthContext = {
  sessionId: "session-1",
  organizationId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  role: "member",
  kind: "web",
  credentialHash: "credential",
};

const REDIRECT = "ohb://auth/callback";
const TICKET_ID = "20000000-0000-4000-8000-000000000003";
const SECRET = "c".repeat(43);

type Recorded = { text: string; values: unknown[] };

/** Un `db` scripté : chaque requête est enregistrée, `answer` choisit ses lignes. */
function fakeDb(calls: Recorded[], answer: (text: string) => unknown[]): SQL {
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = [...strings].join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return Promise.resolve(answer(text));
  }) as unknown as SQL;
  (query as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback) => callback(query);
  return query;
}

function mount(
  db: SQL,
  authContext: AuthContext | null = auth,
  nativeApiPublicUrl = "http://localhost:8790/",
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/api/auth/native/mobile-connect", mobileConnectRoutes(db, { nativeRedirectUris: [REDIRECT] }));
  const protectedApp = new Hono<{ Variables: AppVariables }>();
  protectedApp.use("*", async (context, next) => {
    if (authContext) context.set("auth", authContext);
    await next();
  });
  protectedApp.route("/api/auth/mobile-connect", mobileConnectProtectedRoutes(db, { nativeApiPublicUrl }));
  app.route("/", protectedApp);
  return app;
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

function redeem(app: Hono<{ Variables: AppVariables }>, body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(app.request("/api/auth/native/mobile-connect/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ticket: `${TICKET_ID}.${SECRET}`,
      codeChallenge: "d".repeat(43),
      redirectUri: REDIRECT,
      clientId: "app.openedbot.mobile",
      ...body,
    }),
  }));
}

function ticketRow(overrides: Partial<{ consumedAt: Date | null; expiresAt: Date }> = {}) {
  return {
    organizationId: auth.organizationId,
    userId: auth.userId,
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe("lien et ticket", () => {
  test("le lien est ohb://join avec l'origine de l'API sans barre finale", () => {
    expect(mobileConnectJoinUrl("http://localhost:8790/", "a.b")).toBe("ohb://join?api=http%3A%2F%2Flocalhost%3A8790&ticket=a.b");
  });

  test("seul <uuid>.<secret base64url> est un ticket", () => {
    expect(parseMobileConnectTicket(` ${TICKET_ID}.${SECRET} `)).toEqual({ id: TICKET_ID, secret: SECRET });
    expect(parseMobileConnectTicket(`${TICKET_ID}.short`)).toBeNull();
    expect(parseMobileConnectTicket(`not-a-uuid.${SECRET}`)).toBeNull();
    expect(parseMobileConnectTicket(`${TICKET_ID}.${SECRET}.extra`)).toBeNull();
  });
});

describe("POST /api/auth/mobile-connect/tickets", () => {
  test("crée un ticket de dix minutes et renvoie le lien, sans jamais stocker le secret", async () => {
    const calls: Recorded[] = [];
    const before = Date.now();
    const response = await mount(fakeDb(calls, () => [])).request("/api/auth/mobile-connect/tickets", { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ticketId: string; url: string; expiresAt: string };
    const url = new URL(body.url);
    expect(url.protocol).toBe("ohb:");
    expect(url.host).toBe("join");
    expect(url.searchParams.get("api")).toBe("http://localhost:8790");
    const ticket = parseMobileConnectTicket(url.searchParams.get("ticket") ?? "");
    expect(ticket?.id).toBe(body.ticketId);
    const expiresIn = Date.parse(body.expiresAt) - before;
    expect(expiresIn).toBeGreaterThan(MOBILE_CONNECT_TICKET_TTL_MS - 5_000);
    expect(expiresIn).toBeLessThanOrEqual(MOBILE_CONNECT_TICKET_TTL_MS + 5_000);
    const insert = calls.find((call) => call.text.startsWith("insert into mobile_connect_tickets"));
    expect(insert).toBeDefined();
    expect(insert?.values).not.toContain(ticket?.secret);
    expect(insert?.values).toContain(auth.userId);
  });

  test("une session d'assistance ne connecte pas d'appareil", async () => {
    const response = await mount(fakeDb([], () => []), { ...auth, impersonatedByStaffUserId: "staff" })
      .request("/api/auth/mobile-connect/tickets", { method: "POST" });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("IMPERSONATION_READ_ONLY");
  });

  // readApiConfig needs a token key whatever the environment; a dummy one.
  const base = { RUNTIME_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") };

  test("le lien porte l'origine de l'API native, pas celle de la console", async () => {
    // Production: the console on console.openedbot.app, the iOS build on
    // api.openedbot.app (Release.xcconfig OPENEDBOT_API_ORIGIN).
    const config = readApiConfig({
      ...base,
      API_PUBLIC_URL: "https://console.ohb.example",
      NATIVE_API_PUBLIC_URL: "https://api.ohb.example/",
    });
    const response = await mount(fakeDb([], () => []), auth, config.nativeApiPublicUrl)
      .request("/api/auth/mobile-connect/tickets", { method: "POST" });
    const body = (await response.json()) as { url: string };
    expect(new URL(body.url).searchParams.get("api")).toBe("https://api.ohb.example");
  });

  test("sans NATIVE_API_PUBLIC_URL, l'origine native est API_PUBLIC_URL", () => {
    expect(readApiConfig({ ...base, API_PUBLIC_URL: "https://ohb.example/" }).nativeApiPublicUrl).toBe("https://ohb.example");
    expect(readApiConfig({ ...base, API_PORT: "8790" }).nativeApiPublicUrl).toBe("http://localhost:8790");
  });
});

describe("POST /api/auth/native/mobile-connect/redeem", () => {
  test("refuse une URI de retour inconnue avant de lire la base", async () => {
    const calls: Recorded[] = [];
    const response = await redeem(mount(fakeDb(calls, () => [])), { redirectUri: "https://evil.example/cb" });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("REDIRECT_URI_INVALID");
    expect(calls).toHaveLength(0);
  });

  test("refuse un ticket mal formé sans toucher la base", async () => {
    const calls: Recorded[] = [];
    const response = await redeem(mount(fakeDb(calls, () => [])), { ticket: "oops" });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("MOBILE_CONNECT_TICKET_INVALID");
    expect(calls).toHaveLength(0);
  });

  test("un ticket inconnu est invalide", async () => {
    const response = await redeem(mount(fakeDb([], () => [])), {});
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("MOBILE_CONNECT_TICKET_INVALID");
  });

  test("un ticket déjà servi répond 409", async () => {
    const db = fakeDb([], (text) => text.startsWith("select") ? [ticketRow({ consumedAt: new Date() })] : []);
    const response = await redeem(mount(db), {});
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("MOBILE_CONNECT_TICKET_USED");
  });

  test("un ticket expiré répond 410", async () => {
    const db = fakeDb([], (text) => text.startsWith("select") ? [ticketRow({ expiresAt: new Date(Date.now() - 1) })] : []);
    const response = await redeem(mount(db), {});
    expect(response.status).toBe(410);
    expect(await errorCode(response)).toBe("MOBILE_CONNECT_TICKET_EXPIRED");
  });

  test("deux échanges simultanés : celui qui perd l'update voit le ticket servi", async () => {
    const db = fakeDb([], (text) => text.startsWith("select") ? [ticketRow()] : []);
    const response = await redeem(mount(db), {});
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("MOBILE_CONNECT_TICKET_USED");
  });

  test("un ticket valide est consommé puis échangé contre un code natif", async () => {
    const calls: Recorded[] = [];
    const db = fakeDb(calls, (text) =>
      text.startsWith("select") ? [ticketRow()] : text.startsWith("update mobile_connect_tickets") ? [{ id: TICKET_ID }] : []);
    const response = await redeem(mount(db), {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as { code: string; redirectUri: string };
    expect(body.redirectUri).toBe(REDIRECT);
    expect(body.code.length).toBeGreaterThanOrEqual(32);
    expect(calls.some((call) => call.text.startsWith("update mobile_connect_tickets set consumed_at"))).toBe(true);
    const codeInsert = calls.find((call) => call.text.includes("native_auth_codes"));
    expect(codeInsert).toBeDefined();
    expect(codeInsert?.values).not.toContain(body.code);
    expect(calls.flatMap((call) => call.values)).not.toContain(SECRET);
  });
});
