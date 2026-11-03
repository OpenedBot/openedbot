import { isStrictUuid } from "@openedbot/contracts-primitives";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { WorkerConfig } from "./worker-config";

/**
 * La clé d'objet des pièces du fil, IDENTIQUE à `objectKey` de l'API
 * (`apps/api/src/infrastructure/blob-store.ts`). Le worker écrit dans le
 * même magasin : `GET /api/attachments/:id` relit ce que le tour a posé.
 */
export function artifactObjectKey(organizationId: string, objectId: string): string {
  if (!isStrictUuid(organizationId) || !isStrictUuid(objectId)) throw new Error("Invalid blob identity.");
  return `org/${organizationId}/${objectId}`;
}

export function isValidArtifactObjectKey(key: string): boolean {
  return /^(org|support)\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(key)
    && !key.includes("..")
    && !key.includes("\\");
}

/**
 * Pose les octets dans le magasin déjà servi par la session. `put` seulement :
 * le worker n'a pas à signer d'URL de livraison.
 */
export async function putArtifactBlob(
  blob: NonNullable<WorkerConfig["blob"]>,
  key: string,
  data: Uint8Array,
  contentType: string,
): Promise<"file" | "r2"> {
  if (!isValidArtifactObjectKey(key)) throw new Error("Invalid blob key.");
  if (blob.driver === "file") {
    const root = resolve(blob.root);
    const path = resolve(root, key);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Blob path escaped root.");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Bun.write(path, data);
    return "file";
  }
  const client = new Bun.S3Client({
    bucket: blob.bucket,
    endpoint: blob.endpoint,
    accessKeyId: blob.accessKeyId,
    secretAccessKey: blob.secretAccessKey,
    region: "auto",
  });
  await client.write(key, data, { type: contentType, acl: "private" });
  return "r2";
}

/** Relit les octets posés par l'API ou par `putArtifactBlob`. `null` si la clé est absente. */
export async function getArtifactBlob(
  blob: NonNullable<WorkerConfig["blob"]>,
  key: string,
): Promise<Uint8Array | null> {
  if (!isValidArtifactObjectKey(key)) return null;
  try {
    if (blob.driver === "file") {
      const root = resolve(blob.root);
      const path = resolve(root, key);
      if (path !== root && !path.startsWith(`${root}${sep}`)) return null;
      const file = Bun.file(path);
      if (!(await file.exists())) return null;
      return new Uint8Array(await file.arrayBuffer());
    }
    const client = new Bun.S3Client({
      bucket: blob.bucket,
      endpoint: blob.endpoint,
      accessKeyId: blob.accessKeyId,
      secretAccessKey: blob.secretAccessKey,
      region: "auto",
    });
    const file = client.file(key);
    if (!(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}
