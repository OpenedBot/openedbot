import type { SQL } from "bun";
import {
  claimNextExecutionCommand,
  executeExecutionCommand,
} from "@openedbot/execution/application/execution-commands";
import { createRuntimeClient } from "@openedbot/execution/application/runtime-client";
import type { WorkerConfig } from "../config";
import { logEvent } from "@openedbot/platform-observability";
import { runTraceContext, runWithTrace } from "@openedbot/platform-observability/trace-context";

/** Commands in flight in this worker; a compaction can take minutes, so they never hold the job. */
const MAX_IN_FLIGHT = 2;
const inFlight = new Set<Promise<void>>();

/**
 * Claims the durable execution commands the API recorded and
 * starts each one without waiting for it, under its own lease. On a graceful
 * stop, `signal` hands the running ones back and `track` gives them to the
 * worker's drain, so each release is written before the database closes.
 * Each command runs in its own trace (trace id = command id, a new span per
 * claim), as a run does: its log lines and relayed requests carry it.
 */
export async function processExecutionCommands(
  db: SQL,
  config: WorkerConfig,
  signal: AbortSignal,
  track?: (work: Promise<void>) => void,
  clientFactory: typeof createRuntimeClient = createRuntimeClient,
): Promise<void> {
  while (!signal.aborted && inFlight.size < MAX_IN_FLIGHT) {
    const command = await claimNextExecutionCommand(db, config.workerId);
    if (!command) return;
    const execution: Promise<void> = runWithTrace(runTraceContext(command.id), () => executeExecutionCommand(db, command, {
      signal,
      client: (runtime, profile) => clientFactory({
        runtimeId: runtime.id,
        reachability: runtime.reachability,
        runtimeEndpoint: runtime.endpoint,
        tokenCiphertext: runtime.tokenCiphertext,
        tokenNonce: runtime.tokenNonce,
        tokenTag: runtime.tokenTag,
        tokenKeyId: runtime.tokenKeyId,
        edgeAuthCiphertext: runtime.edgeAuthCiphertext ?? null,
        edgeAuthNonce: runtime.edgeAuthNonce ?? null,
        edgeAuthTag: runtime.edgeAuthTag ?? null,
        edgeAuthKeyId: runtime.edgeAuthKeyId ?? null,
        hermesProfile: profile,
      }, config),
    })
      .catch(() => logEvent("execution_command.worker_failed", { commandId: command.id }, "error")))
      .finally(() => { inFlight.delete(execution); });
    inFlight.add(execution);
    track?.(execution);
  }
}

/** For tests: the commands this worker started. */
export function executionCommandsInFlight(): Promise<unknown> {
  return Promise.allSettled(inFlight);
}
