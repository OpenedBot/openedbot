import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import { secretEncryptionKey } from "@openedbot/hermes/secrets";
import type { ApiConfig } from "../src/infrastructure/config";
import { authRoutes, type AppVariables } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";

const EMAIL = "foo@example.com";
const PASSWORD = "correct-password-for-tests";
const PASSWORD_HASH = await Bun.password.hash(PASSWORD);
const REDIRECT_URI = "http://localhost:47813/callback";
const CODE_CHALLENGE = "A".repeat(43);

type CodeRow = {
  id: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  createdAt: Date;
  consumedAt: Date | null;
  attempts: number;
};

function fixture(options: { organizationId?: string | null } = {}) {
  const emailCodes: CodeRow[] = [];
  const emailOutbox: Array<{ kind: string; email: string; code: string }> = [];
  const sessions: unknown[][] = [];
  const nativeCodes: unknown[][] = [];
  const account = { id: "user-1", email: EMAIL, passwordHash: PASSWORD_HASH };
  const organizationId = options.organizationId === undefined ? "org-1" : options.organizationId;

  const sql = Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join(" ").replace(/\s+/g, " ").toLowerCase();
    const result = Object.assign([], { count: 1 });
    if (query.includes("select id, code_hash as \"codehash\"")) {
      const requestedEmail = String(values[0]);
      const latest = [...emailCodes].reverse().find((row) => row.email === requestedEmail);
      return latest ? [latest] : [];
    }
    if (query.includes("select id, email, password_hash as \"passwordhash\" from users")) {
      return String(values[0]).toLowerCase() === account.email ? [account] : [];
    }
    if (query.includes("select organization_id as \"organizationid\", role from memberships")) {
      return organizationId ? [{ organizationId, role: "owner" }] : [];
    }
    if (query.includes("select slug from organizations")) return organizationId ? [{ slug: "test-workspace" }] : [];
    if (query.includes("update email_login_codes set consumed_at = now()")) {
      for (const row of emailCodes) if (row.email === values[0] && row.consumedAt === null) row.consumedAt = new Date();
    }
    if (query.includes("insert into email_login_codes")) {
      emailCodes.push({
        id: String(values[0]),
        email: String(values[1]),
        codeHash: String(values[2]),
        expiresAt: values[3] as Date,
        createdAt: new Date(),
        consumedAt: null,
        attempts: 0,
      });
    }
    if (query.includes("insert into email_outbox")) {
      const payload = values[5] as { code: string };
      emailOutbox.push({ kind: String(values[1]), email: String(values[3]), code: payload.code });
    }
    if (query.includes("update email_login_codes set attempts = attempts +")) {
      const row = emailCodes.find((entry) => entry.id === values[2]);
      if (row) {
        row.attempts += Number(values[0]);
        if (values[1] || row.attempts >= 5) row.consumedAt = new Date();
      }
    }
    if (query.includes("insert into sessions")) sessions.push(values);
    if (query.includes("insert into native_auth_codes")) nativeCodes.push(values);
    return result;
  }, {
    begin: async (callback: (tx: unknown) => Promise<unknown>) => callback(sql),
  });

  const config = {
    publicUrl: "http://localhost:8790",
    webOrigins: ["http://localhost:1420"],
    environment: "development",
    deployEnvironment: "development",
    billingEnforced: false,
    nativeRedirectUris: [REDIRECT_URI],
    devSignIn: null,
    google: { clientId: "client.test", clientSecret: "secret", allowedEmails: new Set<string>() },
    tokenEncryption: { current: secretEncryptionKey(new Uint8Array(32).fill(9)), previous: [] },
  } as unknown as ApiConfig;
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", authRoutes(sql as unknown as SQL, config));
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));

  return {
    app,
    emailCodes,
    emailOutbox,
    sessions,
    nativeCodes,
    issuedCode: () => emailOutbox.at(-1)?.code ?? "",
    latestCode: () => emailCodes.at(-1),
  };
}

function json(body: Record<string, unknown>): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function nativeBody(email: string, password: string, emailCode?: string): Record<string, unknown> {
  return {
    email,
    password,
    ...(emailCode === undefined ? {} : { emailCode }),
    codeChallenge: CODE_CHALLENGE,
    redirectUri: REDIRECT_URI,
    clientId: "desktop-test",
  };
}

describe("password sign-in e-mail code", () => {
  for (const door of ["web", "native"] as const) {
    const path = door === "web" ? "/login" : "/native/authorize";
    const body = (email = EMAIL, password = PASSWORD, emailCode?: string) => door === "web"
      ? { email, password, ...(emailCode === undefined ? {} : { emailCode }) }
      : nativeBody(email, password, emailCode);

    test(`${door}: password requests a code, and the code gates its existing success response`, async () => {
      const f = fixture();
      const requested = await f.app.request(path, json(body()));
      expect(requested.status).toBe(202);
      expect(await requested.json()).toEqual({ status: "code_required" });
      expect(requested.headers.get("set-cookie")).toBeNull();
      expect(f.emailOutbox).toHaveLength(1);
      expect(f.emailOutbox[0]?.kind).toBe("email_login_code");
      expect(f.sessions).toHaveLength(0);
      expect(f.nativeCodes).toHaveLength(0);

      const invalid = await f.app.request(path, json(body(EMAIL, PASSWORD, "000000" === f.issuedCode() ? "111111" : "000000")));
      expect(invalid.status).toBe(401);
      expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe("EMAIL_LOGIN_CODE_INVALID");
      expect(f.sessions).toHaveLength(0);
      expect(f.nativeCodes).toHaveLength(0);

      const accepted = await f.app.request(path, json(body(EMAIL, PASSWORD, f.issuedCode())));
      expect(accepted.status).toBe(200);
      if (door === "web") {
        expect(await accepted.json()).toMatchObject({ organizationId: "org-1", user: { id: "user-1", email: EMAIL } });
        expect(accepted.headers.get("set-cookie")).toContain("openedbot_session=");
        expect(f.sessions).toHaveLength(1);
      } else {
        const payload = await accepted.json() as { code?: string; redirectUri?: string };
        expect(payload).toMatchObject({ code: expect.any(String), redirectUri: REDIRECT_URI });
        expect(accepted.headers.get("set-cookie")).toBeNull();
        expect(f.nativeCodes).toHaveLength(1);
        expect(f.sessions).toHaveLength(0);
      }
      expect(f.latestCode()?.consumedAt).not.toBeNull();
    });

    test(`${door}: a wrong password neither queues nor consumes a code`, async () => {
      const f = fixture();
      await f.app.request("/login/code", json({ email: EMAIL, locale: "fr" }));
      const response = await f.app.request(path, json(body(EMAIL, "wrong-password", f.issuedCode())));
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("CREDENTIALS_INVALID");
      expect(f.emailOutbox).toHaveLength(1);
      expect(f.latestCode()?.attempts).toBe(0);
      expect(f.latestCode()?.consumedAt).toBeNull();
      expect(f.sessions).toHaveLength(0);
      expect(f.nativeCodes).toHaveLength(0);
      const accepted = await f.app.request(path, json(body(EMAIL, PASSWORD, f.issuedCode())));
      expect(accepted.status).toBe(200);
    });

    test(`${door}: a wrong password without a code sends nothing`, async () => {
      const f = fixture();
      const response = await f.app.request(path, json(body(EMAIL, "wrong-password")));
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("CREDENTIALS_INVALID");
      expect(f.emailOutbox).toHaveLength(0);
      expect(f.emailCodes).toHaveLength(0);
    });

    test(`${door}: an empty code follows the code-request branch`, async () => {
      const f = fixture();
      const response = await f.app.request(path, json(body(EMAIL, PASSWORD, "")));
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "code_required" });
      expect(f.emailOutbox).toHaveLength(1);
    });
  }

  test("the web door burns a code after five wrong guesses and rejects replay", async () => {
    const f = fixture();
    await f.app.request("/login/code", json({ email: EMAIL, locale: "fr" }));
    const wrong = f.issuedCode() === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await f.app.request("/login", json({ email: EMAIL, password: PASSWORD, emailCode: wrong }));
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("EMAIL_LOGIN_CODE_INVALID");
    }
    const burned = await f.app.request("/login", json({ email: EMAIL, password: PASSWORD, emailCode: f.issuedCode() }));
    expect(burned.status).toBe(401);
    expect(f.latestCode()?.attempts).toBe(5);

    f.latestCode()!.createdAt = new Date(Date.now() - 61_000);
    await f.app.request("/login/code", json({ email: EMAIL, locale: "fr" }));
    const validCode = f.issuedCode();
    const accepted = await f.app.request("/login", json({ email: EMAIL, password: PASSWORD, emailCode: validCode }));
    expect(accepted.status).toBe(200);
    const replay = await f.app.request("/login", json({ email: EMAIL, password: PASSWORD, emailCode: validCode }));
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe("EMAIL_LOGIN_CODE_INVALID");
  });

  test("normalized email shares the code issued through /login/code", async () => {
    const f = fixture();
    await f.app.request("/login/code", json({ email: "foo@example.com", locale: "en" }));
    const response = await f.app.request("/login", json({
      email: " Foo@Example.com ",
      password: PASSWORD,
      emailCode: f.issuedCode(),
    }));
    expect(response.status).toBe(200);
    expect(f.latestCode()?.email).toBe(EMAIL);
  });

  test("native membership refusal happens before sending or consuming a code", async () => {
    const f = fixture({ organizationId: null });
    await f.app.request("/login/code", json({ email: EMAIL, locale: "fr" }));
    const validCode = f.issuedCode();
    const response = await f.app.request("/native/authorize", json(nativeBody(EMAIL, PASSWORD, validCode)));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("MEMBERSHIP_REQUIRED");
    expect(f.emailOutbox).toHaveLength(1);
    expect(f.latestCode()?.consumedAt).toBeNull();
    expect(f.latestCode()?.attempts).toBe(0);
    expect(f.nativeCodes).toHaveLength(0);
  });

  test("native password with no membership refuses before requesting a code", async () => {
    const f = fixture({ organizationId: null });
    const response = await f.app.request("/native/authorize", json(nativeBody(EMAIL, PASSWORD)));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("MEMBERSHIP_REQUIRED");
    expect(f.emailOutbox).toHaveLength(0);
  });
});
