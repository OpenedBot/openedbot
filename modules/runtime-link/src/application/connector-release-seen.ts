import { withTenant, type Db, type TransactionDb } from "@openedbot/platform-db";

/**
 * Receipts of the edge-setup release dialog (0109): the member's own rows,
 * behind `app.authenticating_user_id`, like push_subscriptions.
 */
async function asMember<T>(db: Db, organizationId: string, userId: string, callback: (tx: TransactionDb) => Promise<T>): Promise<T> {
  return withTenant(db, organizationId, async (tx) => {
    await tx`select set_config('app.authenticating_user_id', ${userId}, true)`;
    return callback(tx);
  });
}

export async function connectorReleaseSeen(db: Db, organizationId: string, userId: string, version: string): Promise<boolean> {
  const rows = await asMember(db, organizationId, userId, (tx) => tx<{ seen: number }[]>`
    select 1 as seen from runtime_connector_release_seen
     where organization_id = ${organizationId} and user_id = ${userId} and version = ${version}
  `);
  return rows.length > 0;
}

export async function markConnectorReleaseSeen(db: Db, organizationId: string, userId: string, version: string): Promise<void> {
  await asMember(db, organizationId, userId, (tx) => tx`
    insert into runtime_connector_release_seen (organization_id, user_id, version)
    values (${organizationId}, ${userId}, ${version})
    on conflict do nothing
  `);
}
