import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import { secretEncryptionKey } from "@openedbot/hermes/secrets";
import type { ApiConfig } from "../src/infrastructure/config";
import {
  assertTrustedReturnOrigin,
  authRoutes,
  googleOriginSupported,
  type AppVariables,
} from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";

const WEB_ORIGIN = "http://localhost:1420";
const LAN_ORIGIN = "http://172.16.0.50:1420";

const DEV_SIGN_IN = { email: "dev@openedbot.local", password: "generated-dev-password" };

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    publicUrl: "http://localhost:8790",
    webOrigins: [WEB_ORIGIN],
    environment: "development",
    billingEnforced: false,
    nativeRedirectUris: [],
    devSignIn: DEV_SIGN_IN,
    google: { clientId: "client.test", clientSecret: "secret", allowedEmails: new Set<string>() },
    tokenEncryption: { current: secretEncryptionKey(new Uint8Array(32).fill(9)), previous: [] },
    ...overrides,
  } as unknown as ApiConfig;
}

/** Un `db` minimal : seul `attempts.create()` (chemin origine fiable) l'atteint. */
function fakeDb(): SQL {
  const tx = (async () => []) as unknown as SQL;
  (tx as unknown as { begin(callback: (inner: SQL) => Promise<unknown>): Promise<unknown> }).begin =
    async (callback) => callback(tx);
  return tx;
}

function mount(overrides: Partial<ApiConfig> = {}, fleetWorkspacesEnabled = false): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", authRoutes(fakeDb(), config(overrides), fleetWorkspacesEnabled));
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  return app;
}

describe("assertTrustedReturnOrigin", () => {
  test("laisse passer une origine de confiance (WEB_APP_URL ou CORS_ALLOWED_ORIGINS)", () => {
    expect(() => assertTrustedReturnOrigin(`${WEB_ORIGIN}/login?redirect=%2F`, [WEB_ORIGIN])).not.toThrow();
  });

  test("refuse une origine non déclarée : un accès LAN par IP, par exemple", () => {
    expect(() => assertTrustedReturnOrigin(`${LAN_ORIGIN}/login`, [WEB_ORIGIN])).toThrow(HttpError);
    try {
      assertTrustedReturnOrigin(`${LAN_ORIGIN}/login`, [WEB_ORIGIN]);
      throw new Error("devait refuser");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).code).toBe("AUTH_RETURN_ORIGIN_UNTRUSTED");
    }
  });

  test("refuse une URL invalide plutôt que de la traiter comme absente", () => {
    expect(() => assertTrustedReturnOrigin("not-a-url", [WEB_ORIGIN])).toThrow(HttpError);
  });
});

describe("POST /google/start", () => {
  test("répond 400 AUTH_RETURN_ORIGIN_UNTRUSTED pour un returnTo d'origine non listée", async () => {
    const response = await mount().request("/google/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnTo: `${LAN_ORIGIN}/login` }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "AUTH_RETURN_ORIGIN_UNTRUSTED",
        message: "Cette adresse de retour n’est pas autorisée.",
      },
    });
  });

  test("continue de fonctionner pour un returnTo d'origine listée", async () => {
    const response = await mount().request("/google/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnTo: `${WEB_ORIGIN}/login?redirect=%2F` }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { attemptId: string; authorizeUrl: string };
    expect(typeof body.attemptId).toBe("string");
    expect(body.authorizeUrl).toContain("https://accounts.google.com/o/oauth2/v2/auth");
  });

  test("continue de fonctionner sans returnTo", async () => {
    const response = await mount().request("/google/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
  });
});

describe("googleOriginSupported", () => {
  test("accepte l'origine qui partage l'hôte de API_PUBLIC_URL", () => {
    expect(googleOriginSupported(config(), WEB_ORIGIN)).toBe(true);
  });

  test("refuse une origine LAN en développement : le cookie du callback resterait sur localhost", () => {
    expect(googleOriginSupported(config(), LAN_ORIGIN)).toBe(false);
  });

  test("n'impose rien sans en-tête d'origine", () => {
    expect(googleOriginSupported(config(), null)).toBe(true);
  });

  test("n'impose rien hors développement : l'API y a sa propre origine", () => {
    const production = config({ environment: "production", publicUrl: "https://api.example.invalid" });
    expect(googleOriginSupported(production, "https://app.example.invalid")).toBe(true);
  });
});

describe("GET /providers", () => {
  test("publie le compte de développement pour l'autofill de /login", async () => {
    const response = await mount().request("/providers");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      google: { enabled: true },
      password: { enabled: true },
      waitlist: { required: true },
      emailCode: { enabled: true },
      devSignIn: DEV_SIGN_IN,
    });
  });

  // L'agence est un module externe : le cœur ne sème ni ne publie de compte agence.
  test("ne publie que le compte semé du propriétaire, même avec la feature agence", async () => {
    const response = await mount({}, true).request("/providers");
    expect(response.status).toBe(200);
    const body = await response.json() as { devSignIn?: unknown; devSignIns?: unknown };
    expect(body.devSignIn).toEqual(DEV_SIGN_IN);
    expect(body.devSignIns).toBeUndefined();
  });

  test("ne publie aucun identifiant lorsque la configuration n'en porte pas", async () => {
    const response = await mount({ devSignIn: null }).request("/providers");
    expect(await response.json()).toEqual({
      google: { enabled: true },
      password: { enabled: true },
      waitlist: { required: true },
      emailCode: { enabled: true },
    });
  });

  test("désigne Google indisponible depuis un accès LAN, avec sa raison", async () => {
    const response = await mount().request("/providers", { headers: { Origin: LAN_ORIGIN } });
    expect(await response.json()).toEqual({
      google: { enabled: false, reason: "origin_unsupported" },
      password: { enabled: true },
      waitlist: { required: true },
      emailCode: { enabled: true },
      devSignIn: DEV_SIGN_IN,
    });
  });

  test("lit l'origine dans le Referer quand le navigateur n'envoie pas Origin", async () => {
    const response = await mount().request("/providers", { headers: { Referer: `${LAN_ORIGIN}/login` } });
    const body = (await response.json()) as { google: { enabled: boolean; reason?: string } };
    expect(body.google).toEqual({ enabled: false, reason: "origin_unsupported" });
  });

  test("« non configuré » l'emporte sur l'origine", async () => {
    const response = await mount({
      google: { clientId: null, clientSecret: null, allowedEmails: new Set<string>() } as unknown as ApiConfig["google"],
    }).request("/providers", { headers: { Origin: LAN_ORIGIN } });
    const body = (await response.json()) as { google: { enabled: boolean; reason?: string } };
    expect(body.google).toEqual({ enabled: false, reason: "not_configured" });
  });

  test("ferme la connexion par mot de passe en production, et la laisse en preprod", async () => {
    const production = await mount({ deployEnvironment: "prod", devSignIn: null, environment: "production" }).request("/providers");
    expect(await production.json()).toEqual({
      google: { enabled: true },
      password: { enabled: false },
      waitlist: { required: true },
      emailCode: { enabled: true },
    });
    const preprod = await mount({ deployEnvironment: "preprod", devSignIn: null, environment: "production" }).request("/providers");
    const preprodBody = await preprod.json() as { password: { enabled: boolean } };
    expect(preprodBody.password).toEqual({ enabled: true });
  });
});

describe("connexion par mot de passe", () => {
  test("POST /login et /native/authorize refusent en production avant toute vérification", async () => {
    const app = mount({ deployEnvironment: "prod" });
    const login = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@example.com", password: "secret" }),
    });
    expect(login.status).toBe(409);
    expect(await login.json()).toEqual({
      error: {
        code: "AUTH_PASSWORD_DISABLED",
        message: "La connexion par mot de passe n’est pas ouverte sur cet environnement.",
      },
    });
    const native = await app.request("/native/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@example.com", password: "secret" }),
    });
    expect(native.status).toBe(409);
    expect(((await native.json()) as { error: { code: string } }).error.code).toBe("AUTH_PASSWORD_DISABLED");
  });
});

describe("POST /google/start depuis une origine LAN", () => {
  test("refuse en nommant la cause plutôt que de partir vers Google pour revenir sans session", async () => {
    const response = await mount().request("/google/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: LAN_ORIGIN },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "AUTH_GOOGLE_ORIGIN_UNSUPPORTED",
    );
  });
});
