import { describe, expect, test } from "bun:test";
import type { Db } from "@openedbot/platform-db";
import { hashCredential } from "@openedbot/platform-db/credential";
import { emailCodeOpen, requestEmailLoginCode, verifyEmailLoginCode } from "../src/application/email-login-code";
import type { EmailLoginCodeRow } from "../src/sql/email-login-codes";

function fixture() {
  let row: EmailLoginCodeRow | null = null;
  let created = false;
  let tier: unknown = null;
  let emailedCode = "";
  let approved: string | null = null;
  let existing = false;
  const sql = Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    if (query.includes("select id, code_hash")) return row ? [row] : [];
    if (query.includes("insert into email_login_codes")) {
      row = { id: String(values[0]), codeHash: String(values[2]), expiresAt: values[3] as Date, attempts: 0, consumedAt: null, createdAt: new Date() };
    }
    if (query.includes("insert into email_outbox ")) emailedCode = (values[5] as { code: string }).code;
    if (query.includes("update email_login_codes set attempts") && row) {
      row.attempts += Number(values[0]);
      if (values[1] || row.attempts >= 5) row.consumedAt = new Date();
    }
    if (query.includes('display_name as "displayName" from users') && existing) return [{ id: "account", email, displayName: "Camille" }];
    if (query.includes("from memberships") && existing) return [{ organizationId: "organization" }];
    if (query.includes("from organizations") && existing) return [{ id: "organization" }];
    if (query.includes("from waitlist_signups")) return approved ? [{ accessTier: approved }] : [];
    if (query.includes("insert into users")) { created = true; tier = values[4]; }
    return Object.assign([], { count: 1 });
  }, { begin: async (run: (tx: unknown) => unknown) => run(sql) });
  return { db: sql as unknown as Db, row: () => row!, code: () => emailedCode, created: () => created, tier: () => tier, approve: () => { approved = "alpha"; }, existing: () => { existing = true; } };
}

const email = "camille@example.com";

describe("email signup code", () => {
  test("a code just used to sign in does not hold the next code; a burned one does", async () => {
    const f = fixture();
    f.existing();
    await requestEmailLoginCode(f.db, { email, locale: "fr" });
    await verifyEmailLoginCode(f.db, { email, code: f.code(), waitlistRequired: false });
    const used = f.code();
    await requestEmailLoginCode(f.db, { email, locale: "fr" });
    expect(f.code()).not.toBe(used);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await verifyEmailLoginCode(f.db, { email, code: "000000", waitlistRequired: false }).catch(() => undefined);
    }
    await expect(requestEmailLoginCode(f.db, { email, locale: "fr" })).rejects.toMatchObject({ code: "EMAIL_LOGIN_CODE_COOLDOWN" });
  });

  test("queues a hashed, expiring code and creates classic only after verification", async () => {
    const f = fixture();
    await requestEmailLoginCode(f.db, { email, locale: "fr" });
    expect(f.code()).toMatch(/^\d{6}$/);
    expect(f.row().codeHash).toBe(hashCredential(f.code()));
    expect(f.created()).toBe(false);
    const account = await verifyEmailLoginCode(f.db, { email, code: f.code(), waitlistRequired: false });
    expect(account.organizationId).toBeNull();
    expect(f.tier()).toBe("classic");
    await expect(verifyEmailLoginCode(f.db, { email, code: f.code(), waitlistRequired: false })).rejects.toMatchObject({ code: "EMAIL_LOGIN_CODE_INVALID" });
  });

  test("waitlist uses the same refusal as Google and approved addresses get their tier", async () => {
    const f = fixture();
    await requestEmailLoginCode(f.db, { email, locale: "en" });
    await expect(verifyEmailLoginCode(f.db, { email, code: f.code(), waitlistRequired: true })).rejects.toMatchObject({ code: "AUTH_EMAIL_NOT_ALLOWED" });
    expect(f.created()).toBe(false);
    // Real PostgreSQL rolls the refused transaction back; reset the mock row likewise.
    f.row().consumedAt = null;
    f.approve();
    await verifyEmailLoginCode(f.db, { email, code: f.code(), waitlistRequired: true });
    expect(f.tier()).toBe("alpha");
  });

  test("five wrong guesses burn the code and a recent request reuses the pending email", async () => {
    const f = fixture();
    await requestEmailLoginCode(f.db, { email, locale: "fr" });
    const id = f.row().id;
    await requestEmailLoginCode(f.db, { email, locale: "fr" });
    expect(f.row().id).toBe(id);
    const wrong = f.code() === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await expect(verifyEmailLoginCode(f.db, { email, code: wrong, waitlistRequired: false })).rejects.toMatchObject({ code: "EMAIL_LOGIN_CODE_INVALID" });
    }
    expect(emailCodeOpen(f.row())).toBe(false);
    await expect(verifyEmailLoginCode(f.db, { email, code: f.code(), waitlistRequired: false })).rejects.toMatchObject({ code: "EMAIL_LOGIN_CODE_INVALID" });
    expect(f.created()).toBe(false);
  });

  test("existing accounts reuse their organization while the waitlist is on", async () => {
    const f = fixture();
    f.existing();
    await requestEmailLoginCode(f.db, { email, locale: "fr" });
    const result = await verifyEmailLoginCode(f.db, { email, code: f.code(), waitlistRequired: true });
    expect(result.organizationId).toBe("organization");
    expect(result.user.email).toBe(email);
    expect(f.created()).toBe(false);
  });

  test("expired codes cannot open an account", async () => {
    const f = fixture();
    await requestEmailLoginCode(f.db, { email, locale: "fr" });
    f.row().expiresAt = new Date(0);
    await expect(verifyEmailLoginCode(f.db, { email, code: f.code(), waitlistRequired: false })).rejects.toMatchObject({ code: "EMAIL_LOGIN_CODE_INVALID" });
    expect(f.created()).toBe(false);
  });
});
