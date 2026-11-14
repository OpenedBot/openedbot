import type { TransactionDb } from "@openedbot/platform-db";

/**
 * Sérialise, par organisation, tout ce qui peut déclarer un runtime
 * (`POST /api/runtime`, exposition directe, enrôlement par le lien) : sans ce
 * verrou, deux déclarations simultanées passaient chacune le contrôle « aucun
 * remplaçant en attente » et en inséraient deux. Verrou de transaction : il
 * tombe avec elle, commit ou rollback.
 */
export async function lockRuntimeDeclarations(tx: TransactionDb, organizationId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${organizationId}), hashtext('runtime-declaration'))`;
}

/** Un runtime vivant qui ne sert pas : le remplaçant en attente, s'il existe. */
export async function hasPendingReplacement(tx: TransactionDb, organizationId: string): Promise<boolean> {
  const pending = await tx<Array<{ id: string }>>`
    select id from runtimes
     where organization_id = ${organizationId} and revoked_at is null and not is_active
     limit 1
  `;
  return pending.length > 0;
}
