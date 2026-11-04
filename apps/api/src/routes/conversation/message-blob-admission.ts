import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { reserveUncommittedBlobs } from "@openedbot/conversation/sql/uncommitted-blobs";
import type { BlobStore } from "../../infrastructure/blob-store";

export type StoredObject = { key: string; data: Uint8Array; contentType: string };

/**
 * Écrit les octets d'un envoi puis l'admet, dans la transaction du tenant.
 *
 * Les objets d'une soumission idempotente sont déterministes et restent
 * disponibles pour sa reprise après expiration du bail : rien n'est retiré
 * ici. Sans Idempotency-Key (`legacy`), rien ne retrouverait des octets dont
 * le commit a échoué : leurs clés entrent d'abord dans la file durable de
 * suppression, que l'admission vide en écrivant `attachments`. Ils ne sont
 * supprimés tout de suite que sur un rollback certain (échec avant que le
 * COMMIT ne parte) ; si le COMMIT a pu aboutir, ils restent, et la file
 * tranche après son délai : ses lignes ne survivent qu'à un commit échoué.
 */
export async function admitWithStoredBlobs<T>(
  input: {
    db: Db;
    blobs: BlobStore;
    organizationId: string;
    objects: readonly StoredObject[];
    legacy: boolean;
    onStored?: () => void;
  },
  admit: (tx: TransactionDb) => Promise<T>,
): Promise<T> {
  const { db, blobs, organizationId, objects, legacy } = input;
  const keys = objects.map((object) => object.key);
  if (legacy) await reserveUncommittedBlobs(db, organizationId, keys, blobs.driver);
  let commitSent = false;
  try {
    await Promise.all(objects.map((object) => blobs.put(object.key, object.data, object.contentType)));
    if (objects.length > 0) input.onStored?.();
    return await withTenant(db, organizationId, async (tx) => {
      const accepted = await admit(tx);
      // Au-delà, le COMMIT est parti : un échec n'en prouve plus le rollback.
      commitSent = true;
      return accepted;
    });
  } catch (error) {
    if (legacy && keys.length > 0) {
      if (commitSent) {
        console.warn(JSON.stringify({ event: "api.message_blobs_kept_uncertain_commit", organizationId, objects: keys.length }));
      } else {
        await Promise.allSettled(keys.map((key) => blobs.delete(key, blobs.driver)));
      }
    }
    throw error;
  }
}
