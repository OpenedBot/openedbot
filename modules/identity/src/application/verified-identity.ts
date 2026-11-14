import type { Db, TransactionDb } from "@openedbot/platform-db";
import { firstLivingOrganization, firstLivingOrganizationInTransaction } from "../sql/accounts";

export type VerifiedAccount = {
  userId: string;
  organizationId: string | null;
  user: { email: string; displayName: string | null };
};

/** Shared account entry for a verified Google identity or e-mail code.
 * Signup is open: an unknown verified address always gets an account
 * (plan 0005). Organization creation stays in the existing onboarding flow.
 */
export async function resolveVerifiedIdentity(
  db: Db,
  identity: { email: string; displayName: string | null; subject?: string },
  user: { id: string; email: string; displayName: string | null } | null,
  transaction?: TransactionDb,
): Promise<VerifiedAccount> {
  const sql = transaction ?? db;
  if (user) {
    const organizationId = transaction
      ? await firstLivingOrganizationInTransaction(transaction, user.id)
      : await firstLivingOrganization(db, user.id);
    if (organizationId) return { userId: user.id, organizationId, user: { email: user.email, displayName: user.displayName } };
  }
  const userId = user?.id ?? crypto.randomUUID();
  if (!user) {
    await sql`
      insert into users (id, email, google_subject, display_name)
      values (${userId}, ${identity.email}, ${identity.subject ?? null}, ${identity.displayName})
    `;
  }
  return { userId, organizationId: null, user: { email: user?.email ?? identity.email, displayName: identity.displayName ?? user?.displayName ?? null } };
}
