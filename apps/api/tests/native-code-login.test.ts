import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import { secretEncryptionKey } from "@openedbot/hermes/secrets";
import { hashCredential, pkceChallenge } from "@openedbot/platform-db/credential";
import type { ApiConfig } from "../src/infrastructure/config";
import { authRoutes, type AppVariables } from "../src/routes/identity/auth";
import { nativeCodeLoginRoutes } from "../src/routes/identity/native-code-login-routes";
import { isSessionlessCorePath } from "../src/interfaces/http/sessionless-paths";
import { HttpError } from "../src/interfaces/http/http-error";

const MEMBER = "member@example.com";
const NEWCOMER = "newcomer@example.com";
const REDIRECT_URI = "http://localhost:47813/callback";
const CODE_VERIFIER = "v".repeat(64);
const CODE_CHALLENGE = await pkceChallenge(CODE_VERIFIER);
const VERIFY = "/api/auth/native/code/verify";

type CodeRow = { id: string; email: string; codeHash: string; expiresAt: Date; createdAt: Date; consumedAt: Date | null; attempts: number };
type NativeCodeRow = { id: string; organizationId: string | null; userId: string; codeHash: string; codeChallenge: string; redirectUri: string; consumedAt: Date | null };

/** In-memory stand-in for the queries the e-mail code and native PKCE paths run. */
function fixture() {
  const emailCodes: CodeRow[] = [];
  const outbox: Array<{ email: string; code: string }> = [];
  const users = [{ id: "user-1", email: MEMBER, displayName: null as string | null }];
  const memberships = [{ userId: "user-1", organizationId: "org-1" }];
  const nativeCodes: NativeCodeRow[] = [];
  const sessions: Array<{ kind: string; organizationId: unknown; userId: unknown }> = [];
  const logins: string[] = [];

  const sql = Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join(" ").replace(/\s+/g, " ").toLowerCase();
    const result = Object.assign([] as unknown[], { count: 1 });
    if (query.includes("select id, code_hash as \"codehash\"")) {
      const latest = [...emailCodes].reverse().find((row) => row.email === values[0]);
      return latest ? [latest] : [];
    }
    if (query.includes("update email_login_codes set consumed_at = now()")) {
      for (const row of emailCodes) if (row.email === values[0] && row.consumedAt === null) row.consumedAt = new Date();
    }
    if (query.includes("insert into email_login_codes")) {
      emailCodes.push({ id: String(values[0]), email: String(values[1]), codeHash: String(values[2]), expiresAt: values[3] as Date, createdAt: new Date(), consumedAt: null, attempts: 0 });
    }
    if (query.includes("insert into email_outbox")) {
      outbox.push({ email: String(values[3]), code: (values[5] as { code: string }).code });
    }
    if (query.includes("update email_login_codes set attempts = attempts +")) {
      const row = emailCodes.find((entry) => entry.id === values[2]);
      if (row && row.consumedAt === null) {
        row.attempts += Number(values[0]);
        if (values[1] || row.attempts >= 5) row.consumedAt = new Date();
      }
    }
    if (query.includes("select id, email, display_name as \"displayname\" from users")) {
      return users.filter((user) => user.email === values[0]);
    }
    if (query.includes("from memberships")) {
      return memberships.filter((row) => row.userId === values[0]).map(({ organizationId }) => ({ organizationId }));
    }
    if (query.includes("select id from organizations")) return [{ id: values[0] }];
    if (query.includes("waitlist_signups")) throw new Error("signup no longer reads a waitlist");
    if (query.includes("insert into users")) {
      users.push({ id: String(values[0]), email: String(values[1]), displayName: values[3] as string | null });
    }
    if (query.includes("insert into native_auth_codes")) {
      nativeCodes.push({
        id: String(values[0]), organizationId: values[1] as string | null, userId: String(values[2]), codeHash: String(values[3]),
        codeChallenge: String(values[4]), redirectUri: String(values[5]), consumedAt: null,
      });
    }
    if (query.includes("from native_auth_codes where code_hash")) {
      return nativeCodes.filter((row) => row.codeHash === values[0] && row.consumedAt === null);
    }
    if (query.includes("update native_auth_codes set consumed_at")) {
      const row = nativeCodes.find((entry) => entry.id === values[0]);
      if (row) row.consumedAt = new Date();
    }
    if (query.includes("insert into sessions")) {
      sessions.push({ kind: query.includes("'native'") ? "native" : "web", organizationId: values[1], userId: values[2] });
    }
    if (query.includes("update users set last_login_at")) logins.push(String(values[0]));
    return result;
  }, {
    begin: async (callback: (tx: unknown) => Promise<unknown>) => callback(sql),
  });

  const config = {
    publicUrl: "http://localhost:8790",
    webOrigins: ["http://localhost:1420"],
    environment: "development",
    // Production: the password doors are shut; this one must stay open.
    deployEnvironment: "prod",
    billingEnforced: false,
    nativeRedirectUris: [REDIRECT_URI],
    devSignIn: null,
    google: { clientId: "client.test", clientSecret: "secret", allowedEmails: new Set<string>() },
    tokenEncryption: { current: secretEncryptionKey(new Uint8Array(32).fill(9)), previous: [] },
  } as unknown as ApiConfig;
  const db = sql as unknown as SQL;
  // Mounted as `apps/api/src/index.ts` mounts them.
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/auth", authRoutes(db, config));
  app.route("/api/auth/native/code", nativeCodeLoginRoutes(db, config));
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));

  const post = (path: string, body: Record<string, unknown>) => app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const requestCode = async (email: string) => {
    expect((await post("/api/auth/login/code", { email, locale: "fr" })).status).toBe(200);
    return outbox.at(-1)!.code;
  };
  return { post, requestCode, users, emailCodes, nativeCodes, sessions, logins };
}

function verifyBody(email: string, code: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { email, code, codeChallenge: CODE_CHALLENGE, redirectUri: REDIRECT_URI, clientId: "desktop-test", ...overrides };
}

const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");
const errorCode = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;

describe("POST /api/auth/native/code/verify", () => {
  test("is public: the session middleware lets the native prefix through", () => {
    expect(isSessionlessCorePath(VERIFY)).toBe(true);
  });

  test("a right code returns an authorization code that /native/token exchanges with the PKCE verifier", async () => {
    const f = fixture();
    const emailCode = await f.requestCode(MEMBER);
    const response = await f.post(VERIFY, verifyBody(" Member@Example.com ", emailCode));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    const text = await response.text();
    expect(text).not.toContain(emailCode);
    const payload = JSON.parse(text) as { code: string; redirectUri: string };
    expect(Object.keys(payload).sort()).toEqual(["code", "redirectUri"]);
    expect(payload.redirectUri).toBe(REDIRECT_URI);
    expect(f.nativeCodes).toHaveLength(1);
    expect(f.nativeCodes[0]).toMatchObject({ organizationId: "org-1", userId: "user-1", codeHash: hashCredential(payload.code) });
    expect(f.emailCodes.at(-1)?.consumedAt).not.toBeNull();
    // Dated once, at the exchange, never at issuance.
    expect(f.logins).toHaveLength(0);
    expect(f.sessions).toHaveLength(0);

    const wrongVerifier = await f.post("/api/auth/native/token", {
      grantType: "authorization_code", code: payload.code, codeVerifier: "w".repeat(64), redirectUri: REDIRECT_URI,
    });
    expect(wrongVerifier.status).toBe(400);
    expect(await errorCode(wrongVerifier)).toBe("AUTH_CODE_INVALID");

    const exchanged = await f.post("/api/auth/native/token", {
      grantType: "authorization_code", code: payload.code, codeVerifier: CODE_VERIFIER, redirectUri: REDIRECT_URI,
    });
    expect(exchanged.status).toBe(200);
    expect(await exchanged.json()).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String), organizationId: "org-1" });
    expect(f.sessions).toEqual([{ kind: "native", organizationId: "org-1", userId: "user-1" }]);
    expect(f.logins).toEqual(["user-1"]);

    const replay = await f.post(VERIFY, verifyBody(MEMBER, emailCode));
    expect(replay.status).toBe(401);
    expect(await errorCode(replay)).toBe("EMAIL_LOGIN_CODE_INVALID");
  });

  test("a wrong code is 401 and spends one of the five attempts", async () => {
    const f = fixture();
    const emailCode = await f.requestCode(MEMBER);
    const response = await f.post(VERIFY, verifyBody(MEMBER, wrongCode(emailCode)));
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("EMAIL_LOGIN_CODE_INVALID");
    expect(f.emailCodes.at(-1)).toMatchObject({ attempts: 1, consumedAt: null });
    expect(f.nativeCodes).toHaveLength(0);
    expect((await f.post(VERIFY, verifyBody(MEMBER, emailCode))).status).toBe(200);
  });

  test("a redirect URI off the list is 400 and leaves the e-mail code untouched", async () => {
    const f = fixture();
    const emailCode = await f.requestCode(MEMBER);
    const response = await f.post(VERIFY, verifyBody(MEMBER, emailCode, { redirectUri: "https://evil.example/callback" }));
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("REDIRECT_URI_INVALID");
    expect(f.emailCodes.at(-1)).toMatchObject({ attempts: 0, consumedAt: null });
    expect(f.nativeCodes).toHaveLength(0);
  });

  test("malformed fields are refused before the code is checked", async () => {
    const f = fixture();
    const emailCode = await f.requestCode(MEMBER);
    for (const overrides of [
      { email: "not-an-email" },
      { code: "1".repeat(17) },
      { codeChallenge: "short" },
      { clientId: "c".repeat(101) },
      { redirectUri: undefined },
    ]) {
      const response = await f.post(VERIFY, verifyBody(MEMBER, emailCode, overrides));
      expect(response.status).toBe(400);
    }
    expect(f.emailCodes.at(-1)).toMatchObject({ attempts: 0, consumedAt: null });
  });

  test("an unknown address: the account is created as on the web and signs in without an organization, to define it in the onboarding", async () => {
    const web = fixture();
    const webResponse = await web.post("/api/auth/login/code/verify", verifyBody(NEWCOMER, await web.requestCode(NEWCOMER)));
    expect(webResponse.status).toBe(200);
    expect(web.users.map((user) => user.email)).toEqual([MEMBER, NEWCOMER]);

    const native = fixture();
    const response = await native.post(VERIFY, verifyBody(NEWCOMER, await native.requestCode(NEWCOMER)));
    expect(response.status).toBe(200);
    const payload = await response.json() as { code: string };
    expect(native.users.map((user) => user.email)).toEqual([MEMBER, NEWCOMER]);
    const newcomer = native.users.find((user) => user.email === NEWCOMER)!;
    expect(native.nativeCodes).toHaveLength(1);
    expect(native.nativeCodes[0]).toMatchObject({ organizationId: null, userId: newcomer.id });

    const exchanged = await native.post("/api/auth/native/token", {
      grantType: "authorization_code", code: payload.code, codeVerifier: CODE_VERIFIER, redirectUri: REDIRECT_URI,
    });
    expect(exchanged.status).toBe(200);
    expect(await exchanged.json()).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String), organizationId: null });
    expect(native.sessions).toEqual([{ kind: "native", organizationId: null, userId: newcomer.id }]);
  });
});

describe("POST /api/auth/native/token refresh attempt", () => {
  test("rejects malformed attempt secrets before consuming a refresh token", async () => {
    const f = fixture();
    for (const refreshAttempt of [null, 42, "", "a".repeat(42), "a".repeat(44), "!".repeat(43)]) {
      const response = await f.post("/api/auth/native/token", { grantType: "refresh_token", refreshToken: "old", refreshAttempt });
      expect(response.status).toBe(400);
    }
    expect(f.sessions).toHaveLength(0);
  });
  test("accepts legacy requests and a valid attempt shape, then applies token authentication", async () => {
    const f = fixture();
    for (const optional of [{}, { refreshAttempt: "a".repeat(43) }]) {
      const response = await f.post("/api/auth/native/token", { grantType: "refresh_token", refreshToken: "unknown", ...optional });
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("REFRESH_TOKEN_INVALID");
    }
  });
});
