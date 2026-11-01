import type { Db } from "@openedbot/platform-db";

/** La clé d'un blob de support entre dans la file durable de suppression (sans organisation). */
export async function queueSupportBlobDeletion(tx: Db, objectKey: string): Promise<void> {
  await tx`
    insert into tenant_blob_deletions (object_key, organization_id)
    values (${objectKey}, null)
    on conflict (object_key) do nothing
  `;
}
