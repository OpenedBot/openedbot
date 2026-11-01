import type { SQL } from "bun";
import { claimProfileImport, executeProfileImport, purgeOldProfileImports } from "@openedbot/portability/application/executor";
import type { ImportBlobStore } from "@openedbot/portability/sql/roster";
import type { WorkerConfig } from "../config";
import { createRuntimeClient } from "@openedbot/execution/application/runtime-client";
import { deleteBlob } from "../infrastructure/blob-store";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

function importBlobs(config: WorkerConfig): ImportBlobStore {
  return {
    driver: config.blob.driver,
    delete: (key) => deleteBlob(config, key),
    async put(key, bytes, contentType) {
      if (!/^org\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(key)) throw new Error("Invalid import blob key");
      if (config.blob.driver === "r2") {
        const client = new Bun.S3Client({ ...config.blob, region: "auto" });
        await client.write(key, bytes, { type: contentType, acl: "private" });
      } else {
        const root = resolve(config.blob.root);
        const path = resolve(root, key);
        if (!path.startsWith(root + sep)) throw new Error("Invalid import blob path");
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await Bun.write(path, bytes);
      }
    },
  };
}

/** Separate tracked execution: importing profiles must never block run claims. */
export async function processProfileImport(db: SQL, config: WorkerConfig, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const job = await claimProfileImport(db, config.workerId);
  if (!job) return;
  console.info(JSON.stringify({ event: "profile_import.started", jobId: job.id, organizationId: job.organization_id, generation: job.lease_generation }));
  await executeProfileImport(db, job, {
    signal, blobs: importBlobs(config),
    client: (runtimeId, profile) => createRuntimeClient({
      runtimeId, reachability: "connector", runtimeEndpoint: null,
      tokenCiphertext: null, tokenNonce: null, tokenTag: null, tokenKeyId: null, hermesProfile: profile ?? null,
    }, config),
  });
  console.info(JSON.stringify({ event: "profile_import.execution_stopped", jobId: job.id }));
}

export { purgeOldProfileImports };
