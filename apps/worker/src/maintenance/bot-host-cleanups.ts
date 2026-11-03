import type { SQL } from "bun";
import { claimBotHostCleanup, executeBotHostCleanup } from "@openedbot/roster/application/bot-host-cleanups";
import { createRuntimeClient } from "@openedbot/execution/application/runtime-client";
import type { WorkerConfig } from "../config";

export async function processBotHostCleanup(db: SQL, config: WorkerConfig, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const job = await claimBotHostCleanup(db, config.workerId);
  if (!job) return;
  await executeBotHostCleanup(db, job, {
    signal,
    client: (runtimeId, profile) => createRuntimeClient({
      runtimeId,
      reachability: "connector",
      runtimeEndpoint: null,
      tokenCiphertext: null,
      tokenNonce: null,
      tokenTag: null,
      tokenKeyId: null,
      hermesProfile: profile,
    }, config),
  });
}
