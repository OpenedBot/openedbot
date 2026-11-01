import type { Db, TransactionDb } from "@openedbot/platform-db";

export type EmailLoginCodeRow = { id: string; codeHash: string; expiresAt: Date | string; createdAt: Date | string; consumedAt: Date | string | null; attempts: number };

/** Serialize issuance and consumption even before an account exists. */
export function withLoginEmail<T>(db: Db, email: string, run: (tx: TransactionDb) => Promise<T>): Promise<T> {
  return db.begin(async tx => {
    await tx`select set_config('app.login_email', ${email}, true)`;
    await tx`select pg_advisory_xact_lock(hashtextextended(${`email-login:${email}`}, 0))`;
    return run(tx);
  }) as Promise<T>;
}

export async function latestEmailLoginCode(tx: TransactionDb, email: string): Promise<EmailLoginCodeRow | null> {
  const rows = await tx<EmailLoginCodeRow[]>`
    select id, code_hash as "codeHash", expires_at as "expiresAt", created_at as "createdAt",
           consumed_at as "consumedAt", attempts from email_login_codes
     where email = ${email} order by created_at desc limit 1 for update
  `;
  return rows[0] ?? null;
}

export async function insertEmailLoginCode(tx: TransactionDb, email: string, code: { id: string; hash: string; expiresAt: Date }): Promise<void> {
  await tx`update email_login_codes set consumed_at = now() where email = ${email} and consumed_at is null`;
  await tx`insert into email_login_codes (id, email, code_hash, expires_at) values (${code.id}, ${email}, ${code.hash}, ${code.expiresAt})`;
}

export async function recordEmailCodeResult(tx: TransactionDb, id: string, valid: boolean): Promise<void> {
  await tx`
    update email_login_codes set attempts = attempts + ${valid ? 0 : 1},
      consumed_at = case when ${valid} or attempts + 1 >= 5 then now() else consumed_at end
     where id = ${id} and consumed_at is null
  `;
}
