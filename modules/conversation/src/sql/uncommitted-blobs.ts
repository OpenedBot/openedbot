import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";

/**
 * Délai avant que le worker supprime les octets d'un envoi jamais commité.
 * Il couvre très largement l'upload puis la transaction d'admission : passé ce
 * délai, une ligne encore en file désigne un envoi qui n'a pas abouti.
 */
export const UNCOMMITTED_BLOB_GRACE_SECONDS = 3_600;

/**
 * Inscrit les clés d'un envoi sans Idempotency-Key dans la file durable de
 * suppression, AVANT l'upload et dans une transaction à part. La transaction
 * d'admission retire ces lignes en même temps qu'elle écrit `attachments` :
 * un commit réussi les annule, un rollback (certain ou non) les laisse au
 * worker, qui supprime alors des octets que plus rien ne référence.
 */
export async function reserveUncommittedBlobs(
  db: Db,
  organizationId: string,
  keys: readonly string[],
  driver: "file" | "r2",
): Promise<void> {
  if (keys.length === 0) return;
  await withTenant(db, organizationId, async (tx) => {
    for (const key of keys) {
      await tx`
        insert into tenant_blob_deletions (object_key, organization_id, driver, available_at)
        values (${key}, ${organizationId}, ${driver}, now() + (${UNCOMMITTED_BLOB_GRACE_SECONDS} * interval '1 second'))
      `;
    }
  });
}

/**
 * Retire les réservations dans la transaction qui référence les objets. Une
 * ligne absente veut dire que le worker a pu supprimer les octets : on refuse
 * alors de commiter une pièce jointe qui pointerait vers un objet disparu.
 */
export async function claimReservedBlobsTx(tx: TransactionDb, organizationId: string, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    const rows = await tx<Array<{ key: string }>>`
      delete from tenant_blob_deletions
       where object_key = ${key} and organization_id = ${organizationId} and lease_owner is null
       returning object_key as key
    `;
    if (!rows[0]) throw new Error("Attachment blob reservation is missing; its object may already be deleted.");
  }
}
