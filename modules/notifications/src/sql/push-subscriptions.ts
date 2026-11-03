import type { TransactionDb } from "@openedbot/platform-db";

/**
 * Un membre révoqué ne reçoit plus de notification de cette organisation.
 * Appelée par identity dans la transaction qui révoque la membership.
 */
export async function dropMemberPushSubscriptions(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
): Promise<void> {
  await tx`delete from push_subscriptions where organization_id = ${organizationId} and user_id = ${userId}`;
}
