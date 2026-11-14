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

/** Optional maxBytes bounds streamed reads; missing, unreadable or oversized blobs return null. */
export async function getArtifactBlob(
  blob: NonNullable<WorkerConfig["blob"]>,
  key: string,
  maxBytes?: number,
): Promise<Uint8Array | null> {
  if (!isValidArtifactObjectKey(key)) return null;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) throw new Error("Invalid blob read bound.");
  const read = async (file: { arrayBuffer(): Promise<ArrayBuffer>; stream(): ReadableStream<Uint8Array> }): Promise<Uint8Array | null> => {
    if (maxBytes === undefined) return new Uint8Array(await file.arrayBuffer());
    const reader = file.stream().getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let complete = false;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) { complete = true; break; }
        if (next.value.byteLength > maxBytes - bytes) return null;
        bytes += next.value.byteLength;
        chunks.push(next.value);
      }
      const data = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      return data;
    } finally {
      try { if (!complete) await reader.cancel(); } finally { reader.releaseLock(); }
    }
  };
  try {
    if (blob.driver === "file") {
      const root = resolve(blob.root);
      const path = resolve(root, key);
      if (path !== root && !path.startsWith(`${root}${sep}`)) return null;
      const file = Bun.file(path);
      if (!(await file.exists())) return null;
      return await read(file);
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
    return await read(file);
  } catch {
    return null;
  }
}
