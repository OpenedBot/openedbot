import type { Db, TransactionDb } from "@openedbot/platform-db";
import { accessTierForNewOrganization } from "../domain/signup";
import { firstLivingOrganization, firstLivingOrganizationInTransaction, waitlistAccessTier } from "../sql/accounts";

export type VerifiedAccount = {
  userId: string;
  organizationId: string | null;
  user: { email: string; displayName: string | null };
};

/** Shared account entry for a verified Google identity or e-mail code.
 * Organization creation stays in the existing onboarding flow.
 */
export async function resolveVerifiedIdentity(
  db: Db,
  identity: { email: string; displayName: string | null; subject?: string },
  user: { id: string; email: string; displayName: string | null } | null,
  waitlistRequired: boolean,
  transaction?: TransactionDb,
): Promise<VerifiedAccount> {
  const sql = transaction ?? db;
  if (user) {
    const organizationId = transaction
      ? await firstLivingOrganizationInTransaction(transaction, user.id)
      : await firstLivingOrganization(db, user.id);
    if (organizationId) return { userId: user.id, organizationId, user: { email: user.email, displayName: user.displayName } };
  }
  const tier = accessTierForNewOrganization(await waitlistAccessTier(sql, identity.email), waitlistRequired);
  const userId = user?.id ?? crypto.randomUUID();
  if (!user) {
    await sql`
      insert into users (id, email, google_subject, display_name, access_tier)
      values (${userId}, ${identity.email}, ${identity.subject ?? null}, ${identity.displayName}, ${tier})
    `;
  } else if (tier !== null) {
    await sql`update users set access_tier = ${tier}, updated_at = now() where id = ${userId}`;
  }
  return { userId, organizationId: null, user: { email: user?.email ?? identity.email, displayName: identity.displayName ?? user?.displayName ?? null } };
}
