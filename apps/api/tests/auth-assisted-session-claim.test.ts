import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import type { ImpersonationSource } from "@openedbot/platform-plugins";
import type { ApiConfig } from "../src/infrastructure/config";
import { hashCredential } from "../src/infrastructure/crypto";
import { authRoutes, type AppVariables } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";

const ADMIN_ORIGIN = "https://backoffice.ohb.test";
const WEB_ORIGIN = "https://app.ohb.test";
const CLAIM_CODE = "a-one-shot-claim-code-with-enough-entropy";
const db = {} as SQL;

function config(): ApiConfig {
  return {
    environment: "test",
    adminUrl: ADMIN_ORIGIN,
    webUrl: WEB_ORIGIN,
    trustProxy: false,
    google: { clientId: null, clientSecret: null, allowedEmails: new Set<string>() },
    nativeRedirectUris: [],
    devSignIn: null,
  } as unknown as ApiConfig;
}

/** A one-shot source, like the backoffice plug-in's: the first claim opens a session, the next one does not. */
function oneShotSource(calls: Array<{ db: unknown; claimHash: string; device: unknown }>): ImpersonationSource {
  let consumed = false;
  return {
    claim: async (claimDb, claimHash, device) => {
      calls.push({ db: claimDb, claimHash, device });
      if (consumed) return null;
      consumed = true;
      return { token: "session-token", csrf: "csrf-token", organizationId: "org-1", ttlMs: 3_600_000 };
    },
  };
}

function mount(impersonation: ImpersonationSource | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/api/auth", authRoutes(db, config(), false, impersonation));
  return app;
}

function claim(app: Hono<{ Variables: AppVariables }>, origin = ADMIN_ORIGIN) {
  return app.request("/api/auth/assisted-sessions/claim", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Support browser" },
    body: new URLSearchParams({ code: CLAIM_CODE }),
  });
}

describe("assisted session claim (core route, ImpersonationSource port)", () => {
  test("the core no longer answers the pre-11.4 path: only the plug-in's exact alias does", async () => {
    const calls: Array<{ db: unknown; claimHash: string; device: unknown }> = [];
    const app = mount(oneShotSource(calls));
    const legacy = ["/api/auth", ["staff", "impersonations"].join("-"), "claim"].join("/");
    const response = await app.request(legacy, { method: "POST", headers: { Origin: ADMIN_ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: CLAIM_CODE }) });
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  test("solo: no source, the route answers like an unknown route", async () => {
    const response = await claim(mount(null));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route introuvable." } });
  });

  test("hands the hashed code to the source, sets cookies for the session lifetime, and is one-shot", async () => {
    const calls: Array<{ db: unknown; claimHash: string; device: unknown }> = [];
    const app = mount(oneShotSource(calls));
    const first = await claim(app);
    expect(first.status).toBe(303);
    expect(first.headers.get("Location")).toBe(WEB_ORIGIN);
    const cookies = first.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.startsWith("ohb_session=session-token") && cookie.includes("Max-Age=3600"))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith("ohb_csrf=csrf-token") && cookie.includes("Max-Age=3600"))).toBe(true);
    expect(calls).toEqual([{ db, claimHash: hashCredential(CLAIM_CODE), device: { userAgent: "Support browser", ip: null } }]);

    const second = await claim(app);
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({
      error: {
        code: "ASSISTED_SESSION_CLAIM_INVALID",
        message: "Ce lien d’assistance est invalide ou expiré.",
      },
    });
  });

  test("refuses an exchange outside the configured backoffice origin, before asking the source", async () => {
    const calls: Array<{ db: unknown; claimHash: string; device: unknown }> = [];
    const response = await claim(mount(oneShotSource(calls)), "https://attacker.test");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "ASSISTED_SESSION_ORIGIN_INVALID",
        message: "Cette origine ne peut pas ouvrir le mode assistance.",
      },
    });
    expect(calls).toEqual([]);
  });
});
