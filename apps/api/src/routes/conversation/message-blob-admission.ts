import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { reserveUncommittedBlobs } from "@openedbot/conversation/application/uncommitted-blobs";
import type { BlobStore } from "../../infrastructure/blob-store";

export type StoredObject = { key: string; data: Uint8Array; contentType: string };

/**
 * Writes the bytes of a send, then admits it, inside the tenant transaction.
 *
 * The objects of an idempotent submission are deterministic and stay
 * available for its replay after the lease expires: nothing is removed
 * here. Without an Idempotency-Key (`legacy`), nothing would find bytes whose
 * commit failed: their keys first enter the durable deletion
 * queue, which admission drains by writing `attachments`. They are
 * deleted immediately only on a certain rollback (failure before the
 * COMMIT is sent); if the COMMIT may have succeeded, they stay, and the queue
 * decides after its delay: its rows survive only a failed commit.
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
      // Past this point, the COMMIT has been sent: a failure no longer proves its rollback.
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
