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
  const client = (runtimeId: string) => createRuntimeClient({
    runtimeId,
    reachability: "connector",
    runtimeEndpoint: null,
    tokenCiphertext: null,
    tokenNonce: null,
    tokenTag: null,
    tokenKeyId: null,
    hermesProfile: null,
  }, config);
  // Read while the operator's cache is warm: the profile creation drops it
  // (provisionCapabilityBaseline). A failed read is retried there.
  const settable = client(job.runtime_id).hostToolsets()
    .then((toolsets): ReadonlySet<string> => new Set(toolsets.settable), () => null);
  await executeProfileProvision(db, job, {
    signal,
    client,
    baseline: (provision, timings, created) => provisionCapabilityBaseline(
      db, config, provision, timedRuntimeClient(timings), undefined, undefined,
      { settable, bundledSkillsOff: created.bundledSkillsOff, onTools: created.onTools },
    ),
  });
}

/**
 * The runtime client of the baseline, each host call timed into the pass's
 * record (`baseline.<method>Ms`, summed over repeated calls): `baselineMs`
 * alone did not say which of the reads, writes or read-backs was slow.
 */
export function timedRuntimeClient(
  timings: Record<string, number>,
  factory: typeof createRuntimeClient = createRuntimeClient,
): typeof createRuntimeClient {
  return (...args) => {
    const client = factory(...args);
    return new Proxy(client, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function" || typeof property !== "string") return value;
        return (...callArgs: unknown[]) => {
          const startedAt = Date.now();
          const record = () => {
            const key = `baseline.${property}Ms`;
            timings[key] = (timings[key] ?? 0) + (Date.now() - startedAt);
          };
          const result = value.apply(target, callArgs);
          if (result instanceof Promise) return result.finally(record);
          record();
          return result;
        };
      },
    });
  };
}
