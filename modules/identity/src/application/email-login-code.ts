import { randomInt } from "node:crypto";
import type { TransactionalEmailLocale } from "@openedbot/contracts-api";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { constantTimeEqual, hashCredential } from "@openedbot/platform-db/credential";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { enqueueTransactionalEmail } from "@openedbot/notifications/application/transactional-email";
import { insertEmailLoginCode, latestEmailLoginCode, recordEmailCodeResult, withLoginEmail, type EmailLoginCodeRow } from "../sql/email-login-codes";
import { resolveVerifiedIdentity } from "./verified-identity";

const TTL_MS = 10 * 60_000;
const COOLDOWN_MS = 60_000;

/** Same six-digit, ten-minute, five-attempt mechanism as staff /login/code. */
export async function requestEmailLoginCode(db: Db, input: { email: string; locale: TransactionalEmailLocale }): Promise<void> {
  await withLoginEmail(db, input.email, async tx => {
    const latest = await latestEmailLoginCode(tx, input.email);
    if (latest && Date.now() - new Date(latest.createdAt).getTime() < COOLDOWN_MS) {
      if (emailCodeOpen(latest)) return;
      // The cooldown is against mail spam. A code its owner just used to sign
      // in does not hold the next sign-in (sign out, sign back in) for a
      // minute; only a code burned by five wrong guesses does.
      if (!emailCodeUsed(latest)) {
        throw new HttpError(429, "EMAIL_LOGIN_CODE_COOLDOWN", "Patientez une minute avant de demander un nouveau code.");
      }
    }
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const id = crypto.randomUUID();
    await insertEmailLoginCode(tx, input.email, { id, hash: hashCredential(code), expiresAt: new Date(Date.now() + TTL_MS) });
    const queued = await enqueueTransactionalEmail(tx, {
      kind: "email_login_code", dedupeKey: `email-login-code:${id}`, recipientEmail: input.email,
      locale: input.locale, payload: { code, expiresInMinutes: "10" },
    });
    if (!queued) throw new HttpError(503, "EMAIL_LOGIN_CODE_UNSENT", "Le code n’a pas pu être envoyé. Réessayez.");
  });
}

/** Consumed by a right guess (a burned code is consumed with five attempts). */
export function emailCodeUsed(row: EmailLoginCodeRow): boolean {
  return row.consumedAt != null && row.attempts < 5;
}

export function emailCodeOpen(row: EmailLoginCodeRow, now = Date.now()): boolean {
  return row.consumedAt == null && row.attempts < 5 && new Date(row.expiresAt).getTime() > now;
}

async function consumeEmailLoginCodeIn(tx: TransactionDb, email: string, code: string): Promise<boolean> {
  const latest = await latestEmailLoginCode(tx, email);
  if (!latest || !emailCodeOpen(latest)) return false;
  const valid = /^\d{6}$/.test(code) && constantTimeEqual(hashCredential(code), latest.codeHash);
  await recordEmailCodeResult(tx, latest.id, valid);
  return valid;
}

/** Consume the latest sign-in code without opening a nested email lock. */
export async function consumeEmailLoginCode(db: Db, input: { email: string; code: string }): Promise<boolean> {
  return withLoginEmail(db, input.email, tx => consumeEmailLoginCodeIn(tx, input.email, input.code));
}

export async function verifyEmailLoginCode(db: Db, input: { email: string; code: string; waitlistRequired: boolean }) {
  const outcome = await withLoginEmail(db, input.email, async tx => {
    if (!await consumeEmailLoginCodeIn(tx, input.email, input.code)) return null;
    const users = await tx<Array<{ id: string; email: string; displayName: string | null }>>`
      select id, email, display_name as "displayName" from users where lower(email) = ${input.email} limit 1
    `;
    return resolveVerifiedIdentity(db, { email: input.email, displayName: null }, users[0] ?? null, input.waitlistRequired, tx);
  });
  if (!outcome) throw new HttpError(401, "EMAIL_LOGIN_CODE_INVALID", "Code invalide ou expiré.");
  return outcome;
}
