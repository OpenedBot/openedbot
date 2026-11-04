import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { accountSecurityRoutes, type GoogleLinker } from "../src/routes/identity/account-security-routes";
import { HttpError } from "../src/interfaces/http/http-error";

const auth: AuthContext = {
  sessionId: "session-current",
  organizationId: "org-1",
  userId: "user-1",
  role: "owner",
  kind: "web",
  credentialHash: "credential",
};

const CURRENT_PASSWORD = "Correct-Horse-Battery";

type SessionFixture = {
  id: string;
  kind: "web" | "native";
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  userAgent: string | null;
  ip: string | null;
};

const SESSION_ROWS: SessionFixture[] = [
  {
    id: "session-current",
    kind: "web",
    createdAt: new Date("2026-08-30T09:12:00.000Z"),
    lastSeenAt: new Date("2026-08-31T14:03:00.000Z"),
    expiresAt: new Date("2026-09-29T09:12:00.000Z"),
    revokedAt: null,
    revokedReason: null,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    ip: "203.0.113.7",
  },
  {
    id: "session-other",
    kind: "web",
    createdAt: new Date("2026-08-28T09:12:00.000Z"),
    lastSeenAt: new Date("2026-08-29T14:03:00.000Z"),
    expiresAt: new Date("2026-09-27T09:12:00.000Z"),
    revokedAt: null,
    revokedReason: null,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    ip: "198.51.100.4",
  },
];

function mount(db: SQL, authContext: AuthContext = auth): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", authContext);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/", accountSecurityRoutes(db));
  return app;
}

function fakeDb(options: {
  calls: string[];
  bindings?: unknown[][];
  hasPassword?: boolean;
  hasGoogle?: boolean;
  email?: string;
  mustChangePassword?: boolean;
  passwordHash?: string | null;
  sessions?: SessionFixture[];
  deleteReturning?: Array<{ id: string }>;
  revokeOthersReturning?: Array<{ id: string }>;
  beginCount?: { value: number };
}): SQL {
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    options.calls.push(sql);
    options.bindings?.push(values);

    if (sql.includes("select email") && sql.includes('"hasPassword"')) {
      return Promise.resolve([{
        email: options.email ?? "kev@example.com",
        hasPassword: options.hasPassword ?? true,
        hasGoogle: options.hasGoogle ?? false,
        mustChangePassword: options.mustChangePassword ?? false,
      }]);
    }
    if (sql.includes("google_subject as \"googleSubject\"")) {
      return Promise.resolve([{
        email: options.email ?? "kev@example.com",
        googleSubject: options.hasGoogle ? "google-sub-1" : null,
        passwordHash: options.passwordHash === undefined ? null : options.passwordHash,
      }]);
    }
    if (sql.includes("revoked_reason = 'google_unlink'")) {
      return Promise.resolve(options.revokeOthersReturning ?? []);
    }
    if (sql.includes("select password_hash as \"passwordHash\"")) {
      return Promise.resolve([{ passwordHash: options.passwordHash === undefined ? null : options.passwordHash }]);
    }
    if (sql.includes("select id, kind, created_at")) {
      return Promise.resolve(options.sessions ?? SESSION_ROWS);
    }
    if (sql.includes("revoked_reason = 'user_revoked'") && sql.includes("where id =")) {
      return Promise.resolve(options.deleteReturning ?? []);
    }
    if (sql.includes("revoked_reason = 'user_revoked'") && sql.includes("id <>")) {
      return Promise.resolve(options.revokeOthersReturning ?? []);
    }
    if (sql.includes("update users set password_hash")) {
      return Promise.resolve([]);
    }
    if (sql.includes("revoked_reason = 'password_change'")) {
      return Promise.resolve(options.revokeOthersReturning ?? []);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (query as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => {
      if (options.beginCount) options.beginCount.value += 1;
      return callback(query);
    };
  return query;
}

describe("GET /api/account/security", () => {
  test("1. compte local : method = { password: true, google: false }", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({ calls, hasPassword: true, hasGoogle: false })).request("/", { method: "GET" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.method).toEqual({ email: "kev@example.com", password: true, google: false });
  });

  test("2. compte SSO-only : method = { password: false, google: true }", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({ calls, hasPassword: false, hasGoogle: true })).request("/", { method: "GET" });
    const body = await response.json();
    expect(body.method).toEqual({ email: "kev@example.com", password: false, google: true });
  });

  test("3. compte mixte : les deux true", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({ calls, hasPassword: true, hasGoogle: true })).request("/", { method: "GET" });
    const body = await response.json();
    expect(body.method).toEqual({ email: "kev@example.com", password: true, google: true });
  });

  test("4. marquage : current === true sur exactement une ligne, celle d'auth.sessionId", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({ calls })).request("/", { method: "GET" });
    const body = await response.json();
    const currentRows = body.sessions.filter((s: { current: boolean }) => s.current);
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0].id).toBe("session-current");
  });

  test("5. fuite : JSON.stringify(body) ne contient aucune clé hash/token/secret/csrf", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({ calls })).request("/", { method: "GET" });
    const body = await response.json();
    expect(/hash|token|secret|csrf/i.test(JSON.stringify(body))).toBe(false);
  });

  test("6. porte RLS : le SQL capturé contient set_config('app.authenticating_user_id'", async () => {
    const calls: string[] = [];
    await mount(fakeDb({ calls })).request("/", { method: "GET" });
    expect(calls.some((sql) => sql.includes("set_config('app.authenticating_user_id'"))).toBe(true);
  });
  test("6c. une session d'assistance staff n'est pas un appareil du titulaire", async () => {
    const calls: string[] = [];
    await mount(fakeDb({ calls })).request("/", { method: "GET" });
    const list = calls.find((sql) => sql.includes("from sessions"));
    expect(list).toContain("impersonated_by_staff_user_id is null");
  });
  test("6b. un mot de passe temporaire se voit dans la réponse", async () => {
    const calls: string[] = [];
    const ordinary = await mount(fakeDb({ calls })).request("/", { method: "GET" });
    expect((await ordinary.json()).mustChangePassword).toBe(false);

    const provisioned = await mount(fakeDb({ calls, mustChangePassword: true })).request("/", { method: "GET" });
    // L'écran l'affiche, et le garde de route de la PWA s'appuie dessus : un
    // compte ouvert par l'équipe n'accède à rien d'autre tant qu'il est levé.
    expect((await provisioned.json()).mustChangePassword).toBe(true);
  });
});

describe("DELETE /api/account/security/sessions/:sessionId", () => {
  test("7. autre session : 204 + update ciblant le bon id, revoked_reason='user_revoked'", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const response = await mount(fakeDb({ calls, bindings, deleteReturning: [{ id: "session-other" }] }))
      .request("/sessions/session-other", { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(calls.some((sql) => sql.includes("revoked_reason = 'user_revoked'") && sql.includes("where id ="))).toBe(true);
    const updateBinding = bindings.find((values) => values.includes("session-other") && values.includes("user-1"));
    expect(updateBinding).toBeDefined();
  });

  test("8. session courante : 409 SESSION_IS_CURRENT, aucun update émis", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({ calls })).request("/sessions/session-current", { method: "DELETE" });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("SESSION_IS_CURRENT");
    expect(calls.some((sql) => sql.startsWith("update sessions"))).toBe(false);
  });

  test("9. 0 ligne touchée : 404 SESSION_NOT_FOUND", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({ calls, deleteReturning: [] }))
      .request("/sessions/session-unknown", { method: "DELETE" });
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("SESSION_NOT_FOUND");
  });
});

describe("POST /api/account/security/sessions/revoke-others", () => {
  test("10. where ... id <> $current, { revoked: n }", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb({
      calls,
      revokeOthersReturning: [{ id: "session-other" }, { id: "session-old" }],
    })).request("/sessions/revoke-others", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: 2 });
    expect(calls.some((sql) => sql.includes("id <>"))).toBe(true);
    // Invisible dans la liste, donc ni révoquée ni comptée ici.
    expect(calls.some((sql) => sql.includes("id <>") && sql.includes("impersonated_by_staff_user_id is null"))).toBe(true);
  });
});

describe("POST /api/account/security/password", () => {
  async function passwordRequest(db: SQL, body: Record<string, unknown>) {
    return mount(db).request("/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("11. mauvais mot de passe actuel : 401 CREDENTIALS_INVALID, aucun update users", async () => {
    const calls: string[] = [];
    const passwordHash = await Bun.password.hash(CURRENT_PASSWORD, { algorithm: "argon2id" });
    const response = await passwordRequest(fakeDb({ calls, passwordHash }), {
      currentPassword: "wrong-password-entirely",
      newPassword: "A-Brand-New-Password-1",
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("CREDENTIALS_INVALID");
    expect(calls.some((sql) => sql.includes("update users set password_hash"))).toBe(false);
  });

  test("12. compte SSO-only : 409 PASSWORD_NOT_SET", async () => {
    const calls: string[] = [];
    const response = await passwordRequest(fakeDb({ calls, passwordHash: null }), {
      currentPassword: CURRENT_PASSWORD,
      newPassword: "A-Brand-New-Password-1",
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("PASSWORD_NOT_SET");
  });

  test("13. nouveau mot de passe trop court : 400 PASSWORD_TOO_WEAK", async () => {
    const calls: string[] = [];
    const passwordHash = await Bun.password.hash(CURRENT_PASSWORD, { algorithm: "argon2id" });
    const response = await passwordRequest(fakeDb({ calls, passwordHash }), {
      currentPassword: CURRENT_PASSWORD,
      newPassword: "short11ch",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("PASSWORD_TOO_WEAK");
  });

  /**
   * La règle de forme a trois exigences, pas une. La route ne rejetait que sur
   * un test nommant `too_short` / `too_long` : une majuscule ou un caractère
   * spécial manquant passait au travers du SERVEUR alors que le client, lui,
   * refusait déjà d'envoyer : la règle n'était donc appliquée nulle part où
   * elle compte.
   *
   * Chaque cas est isolé (une seule exigence en défaut), et on vérifie qu'AUCUN
   * hash n'a été écrit : un 400 qui aurait quand même touché `users` serait
   * pire qu'un 200.
   */
  test("13b. chaque exigence de forme manquante : 400 PASSWORD_TOO_WEAK, aucune écriture", async () => {
    const passwordHash = await Bun.password.hash(CURRENT_PASSWORD, { algorithm: "argon2id" });
    const cases: Array<{ rule: string; newPassword: string }> = [
      { rule: "majuscule", newPassword: "assez-long-minuscule" },
      { rule: "caractère spécial", newPassword: "AssezLongSansSymbole" },
      { rule: "longueur", newPassword: "Court-1!" },
    ];
    for (const { rule, newPassword } of cases) {
      const calls: string[] = [];
      const response = await passwordRequest(fakeDb({ calls, passwordHash }), {
        currentPassword: CURRENT_PASSWORD,
        newPassword,
      });
      expect(`${rule}: ${response.status}`).toBe(`${rule}: 400`);
      expect((await response.json()).error.code).toBe("PASSWORD_TOO_WEAK");
      expect(calls.some((sql) => sql.includes("update users set password_hash"))).toBe(false);
    }
  });

  /** Le pendant positif : les trois exigences réunies passent la porte. */
  test("13c. 12 caractères, une majuscule et un caractère spécial : accepté", async () => {
    const passwordHash = await Bun.password.hash(CURRENT_PASSWORD, { algorithm: "argon2id" });
    const response = await passwordRequest(fakeDb({ calls: [], passwordHash }), {
      currentPassword: CURRENT_PASSWORD,
      newPassword: "Douze-Caracteres!",
    });
    expect(response.status).toBe(200);
  });

  test("14. nouveau mot de passe identique à l'actuel : 400 PASSWORD_UNCHANGED", async () => {
    const calls: string[] = [];
    const passwordHash = await Bun.password.hash(CURRENT_PASSWORD, { algorithm: "argon2id" });
    const response = await passwordRequest(fakeDb({ calls, passwordHash }), {
      currentPassword: CURRENT_PASSWORD,
      newPassword: CURRENT_PASSWORD,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("PASSWORD_UNCHANGED");
  });

  test("15. nominal : update users set password_hash avec un hash re-calculé", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const oldHash = await Bun.password.hash(CURRENT_PASSWORD, { algorithm: "argon2id" });
    const nextPassword = "A-Brand-New-Password-1";
    await passwordRequest(fakeDb({ calls, bindings, passwordHash: oldHash }), {
      currentPassword: CURRENT_PASSWORD,
      newPassword: nextPassword,
    });
    const updateCallIndex = calls.findIndex((sql) => sql.includes("update users set password_hash"));
    expect(updateCallIndex).toBeGreaterThanOrEqual(0);
    const newHash = bindings[updateCallIndex]?.[0] as string;
    expect(newHash).not.toBe(oldHash);
    expect(await Bun.password.verify(nextPassword, newHash)).toBe(true);
  });

  test("15b. espaces de bord : le mot de passe actuel se vérifie tel que haché, le nouveau est haché tel que saisi", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const current = ` ${CURRENT_PASSWORD} `;
    const nextPassword = "  A-Brand-New-Password-1 ";
    const response = await passwordRequest(fakeDb({
      calls,
      bindings,
      passwordHash: await Bun.password.hash(current, { algorithm: "argon2id" }),
    }), { currentPassword: current, newPassword: nextPassword });
    expect(response.status).toBe(200);
    const newHash = bindings[calls.findIndex((sql) => sql.includes("update users set password_hash"))]?.[0] as string;
    expect(await Bun.password.verify(nextPassword, newHash)).toBe(true);
    expect(await Bun.password.verify(nextPassword.trim(), newHash)).toBe(false);
  });

  test("16. atomicité : update users et update sessions dans la même transaction, session courante exclue", async () => {
    const calls: string[] = [];
    const beginCount = { value: 0 };
    const passwordHash = await Bun.password.hash(CURRENT_PASSWORD, { algorithm: "argon2id" });
    const response = await passwordRequest(fakeDb({
      calls, passwordHash, beginCount,
      revokeOthersReturning: [{ id: "session-other" }],
    }), {
      currentPassword: CURRENT_PASSWORD,
      newPassword: "A-Brand-New-Password-1",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revokedOtherSessions: 1 });
    expect(beginCount.value).toBe(1);
    expect(calls.some((sql) => sql.includes("update users set password_hash"))).toBe(true);
    expect(calls.some((sql) =>
      sql.includes("revoked_reason = 'password_change'") && sql.includes("id <>"))).toBe(true);
    // Le drapeau du mot de passe temporaire tombe DANS ce même update : posé
    // ailleurs, il survivrait à un changement de mot de passe réussi et
    // laisserait la personne enfermée sur l'écran de sécurité.
    expect(calls.some((sql) =>
      sql.includes("update users set password_hash")
      && sql.includes("must_change_password = false"))).toBe(true);
  });

  test("17. non-fuite : aucun binding ne porte le mot de passe en clair hors verify/hash", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const passwordHash = await Bun.password.hash(CURRENT_PASSWORD, { algorithm: "argon2id" });
    const nextPassword = "A-Brand-New-Password-1";
    await passwordRequest(fakeDb({ calls, bindings, passwordHash }), {
      currentPassword: CURRENT_PASSWORD,
      newPassword: nextPassword,
    });
    const flat = bindings.flat();
    expect(flat.includes(CURRENT_PASSWORD)).toBe(false);
    expect(flat.includes(nextPassword)).toBe(false);
  });
});

describe("POST /api/account/security/google/unlink", () => {
  async function unlinkRequest(db: SQL, body: Record<string, unknown>) {
    return mount(db).request("/google/unlink", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("18. sans mot de passe, 409 GOOGLE_UNLINK_NEEDS_PASSWORD, aucune écriture", async () => {
    const calls: string[] = [];
    const response = await unlinkRequest(fakeDb({ calls, hasGoogle: true, passwordHash: null }), {
      currentPassword: CURRENT_PASSWORD,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("GOOGLE_UNLINK_NEEDS_PASSWORD");
    expect(calls.some((sql) => sql.includes("google_unlinked_at = now()"))).toBe(false);
  });

  test("19. Google déjà délié, 409 GOOGLE_NOT_LINKED", async () => {
    const calls: string[] = [];
    const passwordHash = await Bun.password.hash(CURRENT_PASSWORD, { algorithm: "argon2id" });
    const response = await unlinkRequest(fakeDb({ calls, hasGoogle: false, passwordHash }), {
      currentPassword: CURRENT_PASSWORD,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("GOOGLE_NOT_LINKED");
  });

  test("20. mauvais mot de passe, 401 CREDENTIALS_INVALID, le lien reste", async () => {
    const calls: string[] = [];
    const passwordHash = await Bun.password.hash(CURRENT_PASSWORD, { algorithm: "argon2id" });
    const response = await unlinkRequest(fakeDb({ calls, hasGoogle: true, passwordHash }), {
      currentPassword: "wrong-password-entirely",
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("CREDENTIALS_INVALID");
    expect(calls.some((sql) => sql.includes("google_subject = null"))).toBe(false);
  });

  test("21. nominal, lien retiré, déliaison datée et autres sessions révoquées dans la même transaction", async () => {
    const calls: string[] = [];
    const beginCount = { value: 0 };
    const passwordHash = await Bun.password.hash(CURRENT_PASSWORD, { algorithm: "argon2id" });
    const response = await unlinkRequest(fakeDb({
      calls,
      beginCount,
      hasGoogle: true,
      passwordHash,
      revokeOthersReturning: [{ id: "session-other" }],
    }), { currentPassword: CURRENT_PASSWORD });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revokedOtherSessions: 1 });
    expect(beginCount.value).toBe(1);
    expect(calls.some((sql) =>
      sql.includes("google_subject = null") && sql.includes("google_unlinked_at = now()"))).toBe(true);
    expect(calls.some((sql) => sql.includes("revoked_reason = 'google_unlink'") && sql.includes("id <>"))).toBe(true);
  });
});

describe("POST /api/account/security/google/link/*", () => {
  function linker(overrides: Partial<GoogleLinker> = {}): GoogleLinker & { started: unknown[]; claimed: unknown[] } {
    const started: unknown[] = [];
    const claimed: unknown[] = [];
    return {
      enabled: true,
      started,
      claimed,
      async start(returnTo, native, link) {
        started.push({ returnTo, native, link });
        return { attemptId: "attempt-1", authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth" };
      },
      async claimLink(attemptId, userId) {
        claimed.push({ attemptId, userId });
        return { status: "pending" };
      },
      ...overrides,
    };
  }

  function mountWithGoogle(google: GoogleLinker | undefined) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => {
      context.set("auth", auth);
      await next();
    });
    app.onError((error, context) => error instanceof HttpError
      ? context.json({ error: { code: error.code } }, error.status as 400)
      : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
    app.route("/", accountSecurityRoutes(fakeDb({ calls: [] }), { google }));
    return app;
  }

  test("22. la tentative est liée à l'utilisateur de la session, sans returnTo ni option native", async () => {
    const google = linker();
    const response = await mountWithGoogle(google).request("/google/link/start", { method: "POST" });
    expect(response.status).toBe(200);
    expect((await response.json()).attemptId).toBe("attempt-1");
    expect(google.started).toEqual([{ returnTo: null, native: null, link: { userId: "user-1" } }]);
  });

  test("23. Google non configuré, 409 AUTH_PROVIDER_DISABLED", async () => {
    const response = await mountWithGoogle(linker({ enabled: false })).request("/google/link/start", { method: "POST" });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("AUTH_PROVIDER_DISABLED");
  });

  test("24. le claim est fait au nom de l'utilisateur de la session", async () => {
    const google = linker();
    const response = await mountWithGoogle(google).request("/google/link/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId: "attempt-1" }),
    });
    expect(await response.json()).toEqual({ status: "pending" });
    expect(google.claimed).toEqual([{ attemptId: "attempt-1", userId: "user-1" }]);
  });
});
