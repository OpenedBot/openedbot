import type { SQL } from "bun";
import { claimProfileProvision, executeProfileProvision } from "@openedbot/roster/application/profile-provisions";
import { createRuntimeClient } from "@openedbot/execution/application/runtime-client";
import type { WorkerConfig } from "../config";
import { provisionCapabilityBaseline } from "./capability-baseline-reconciliation";

export async function processProfileProvision(db: SQL, config: WorkerConfig, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const job = await claimProfileProvision(db, config.workerId);
  if (!job) return;
  console.info(JSON.stringify({
    event: "profile_provision.started",
    botId: job.bot_id,
    organizationId: job.organization_id,
    generation: job.lease_generation,
  }));
  await executeProfileProvision(db, job, {
    signal,
    client: (runtimeId) => createRuntimeClient({
      runtimeId,
      reachability: "connector",
      runtimeEndpoint: null,
      tokenCiphertext: null,
      tokenNonce: null,
      tokenTag: null,
      tokenKeyId: null,
      hermesProfile: null,
    }, config),
    baseline: (provision) => provisionCapabilityBaseline(db, config, provision),
  });
}
