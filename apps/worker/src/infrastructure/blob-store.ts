import { resolve, sep } from "node:path";
import type { WorkerConfig } from "../config";

/**
 * Shared idempotent blob deletion used by tenant and ingress maintenance.
 *
 * Two key shapes, and the guard knows both. `org/<organization>/<object>` for
 * tenant data. `support/<conversation>/<attachment>` was a help desk
 * screenshot: the desk has left the open core and nothing queues that shape
 * any more, but a row it queued before must still drain from
 * `tenant_blob_deletions` rather than fail on every pass; the shape leaves
 * with the migration that drops the `support_*` tables.
 *
 * The guard is not decoration. It is what keeps a queued row from naming an
 * arbitrary path: anything outside these two shapes is refused loudly, and the
 * row is retried rather than silently skipped.
 */
export async function deleteBlob(
  config: Pick<WorkerConfig, "blob" | "blobOther">,
  key: string,
  driver: "file" | "r2" | null = config.blob.driver,
): Promise<void> {
  if (!/^(org|support)\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(key) || key.includes("..")) {
    throw new Error("Invalid deletion blob key.");
  }
  const backends = [config.blob, ...(config.blobOther ? [config.blobOther] : [])];
  // Driver inconnu (ligne d'avant 0171, manifeste d'ingestion) : chaque
  // magasin joignable, tous idempotents. Driver connu : le sien seulement, et
  // un magasin absent est un échec réessayé, jamais une suppression confirmée
  // sur le mauvais.
  const targets = driver === null ? backends : backends.filter((backend) => backend.driver === driver);
  if (targets.length === 0) throw new Error(`Blob driver ${driver} is not configured on this worker.`);
  for (const backend of targets) await deleteFrom(backend, key);
}

type Backend = Pick<WorkerConfig, "blob">["blob"] | NonNullable<WorkerConfig["blobOther"]>;

async function deleteFrom(backend: Backend, key: string): Promise<void> {
  if (backend.driver === "r2") {
    const client = new Bun.S3Client({
      bucket: backend.bucket,
      endpoint: backend.endpoint,
      accessKeyId: backend.accessKeyId,
      secretAccessKey: backend.secretAccessKey,
      region: "auto",
    });
    await client.delete(key);
    return;
  }
  const root = resolve(backend.root);
  const path = resolve(root, key);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("Deletion blob path escaped root.");
  const file = Bun.file(path);
  if (await file.exists()) await file.delete();
}
