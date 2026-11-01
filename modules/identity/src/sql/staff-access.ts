import type { AccessTier } from "@openedbot/contracts-api";
import type { Db, TransactionDb } from "@openedbot/platform-db";

/**
 * Writes of `users` and `sessions` that the staff backoffice triggers. The SQL
 * lives with its owner (identity); staff calls these with its own transaction.
 */

/**
 * Le mode d'accès est celui que l'équipe vient d'accorder, pas celui d'une
 * vie précédente. Le hachage n'est remplacé que si un mot de passe a été
 * fabriqué ; `coalesce` garde l'ancien sinon.
 */
export async function reopenUserAccess(
  db: Db,
  userId: string,
  input: { tier: AccessTier; passwordHash: string | null },
): Promise<void> {
  await db`
    update users
       set access_tier = ${input.tier},
           password_hash = coalesce(${input.passwordHash}, password_hash),
           must_change_password = ${input.passwordHash !== null},
           updated_at = now()
     where id = ${userId}
  `;
}

/** Monte le compte accordé par l'équipe ; une adresse déjà prise lève une violation d'unicité. */
export async function insertProvisionedUser(
  db: Db,
  input: {
    userId: string;
    email: string;
    passwordHash: string | null;
    displayName: string | null;
    tier: AccessTier;
  },
): Promise<void> {
  await db`
    insert into users (id, email, password_hash, display_name, access_tier, must_change_password)
    values (${input.userId}, ${input.email}, ${input.passwordHash}, ${input.displayName}, ${input.tier}, true)
  `;
}

/** Le mode accordé suit le COMPTE, pas seulement l'inscription. */
export async function setUserAccessTier(tx: TransactionDb, userId: string, tier: AccessTier): Promise<void> {
  await tx`
    update users set access_tier = ${tier}, updated_at = now() where id = ${userId}
  `;
}

/** Session web ouverte par le staff au nom d'un compte (`impersonated_by_staff_user_id`). */
export async function insertImpersonatedSession(
  tx: TransactionDb,
  input: {
    sessionId: string;
    organizationId: string;
    userId: string;
    sessionTokenHash: string;
    csrfHash: string;
    accessExpiresAt: Date;
    userAgent: string | null;
    ip: string | null;
    staffUserId: string;
  },
): Promise<void> {
  await tx`
    insert into sessions (
      id, organization_id, user_id, kind, session_token_hash, csrf_hash,
      access_expires_at, user_agent, ip, impersonated_by_staff_user_id
    ) values (
      ${input.sessionId}, ${input.organizationId}, ${input.userId}, 'web', ${input.sessionTokenHash},
      ${input.csrfHash}, ${input.accessExpiresAt},
      ${input.userAgent}, ${input.ip}, ${input.staffUserId}
    )
  `;
}
