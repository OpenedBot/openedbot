import type { SQL } from "bun";
import {
  claimProfileDelete,
  executeProfileDelete,
  purgeOldProfileDeletes,
} from "@openedbot/portability/application/delete-executor";
import { createRuntimeClient } from "@openedbot/execution/application/runtime-client";
import type { WorkerConfig } from "../config";
import { logEvent } from "@openedbot/platform-observability";

/** Separate tracked execution: deleting host profiles must never block run claims. */
export async function processProfileDelete(db: SQL, config: WorkerConfig, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const job = await claimProfileDelete(db, config.workerId);
  if (!job) return;
  logEvent("profile_delete.started", {
    jobId: job.id,
    organizationId: job.organization_id,
    generation: job.lease_generation,
    total: job.total_profiles,
  });
  await executeProfileDelete(db, job, {
    signal,
    client: (runtimeId, profile) => createRuntimeClient({
      runtimeId,
      reachability: "connector",
      runtimeEndpoint: null,
      tokenCiphertext: null,
      tokenNonce: null,
      tokenTag: null,
      tokenKeyId: null,
      hermesProfile: profile ?? null,
    }, config),
  });
  logEvent("profile_delete.execution_stopped", { jobId: job.id });
}

export { purgeOldProfileDeletes };
