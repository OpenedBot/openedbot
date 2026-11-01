import { resolve, sep } from "node:path";
import type { WorkerConfig } from "../config";

/**
 * Shared idempotent blob deletion used by tenant, ingress and support
 * maintenance.
 *
 * Two key shapes, and the guard knows both. `org/<organization>/<object>` for
 * tenant data, `support/<conversation>/<attachment>` for a support desk
 * screenshot: the support desk has no organization, so it cannot borrow the
 * first prefix.
 *
 * The guard is not decoration. It is what keeps a queued row from naming an
 * arbitrary path: anything outside these two shapes is refused loudly, and the
 * row is retried rather than silently skipped.
 */
export async function deleteBlob(config: Pick<WorkerConfig, "blob">, key: string): Promise<void> {
  if (!/^(org|support)\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(key) || key.includes("..")) {
    throw new Error("Invalid deletion blob key.");
  }
  if (config.blob.driver === "r2") {
    const client = new Bun.S3Client({
      bucket: config.blob.bucket,
      endpoint: config.blob.endpoint,
      accessKeyId: config.blob.accessKeyId,
      secretAccessKey: config.blob.secretAccessKey,
      region: "auto",
    });
    await client.delete(key);
    return;
  }
  const root = resolve(config.blob.root);
  const path = resolve(root, key);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("Deletion blob path escaped root.");
  const file = Bun.file(path);
  if (await file.exists()) await file.delete();
}
