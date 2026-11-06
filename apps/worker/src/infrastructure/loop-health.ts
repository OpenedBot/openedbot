import { stat, writeFile } from "node:fs/promises";
import { logEvent } from "@openedbot/platform-observability";

/** Past this gap without a claim-loop turn, the worker stops vouching for itself. */
export const LOOP_STALL_MS = 30_000;
/** The 5 s heartbeat refreshes the file; three missed refreshes read as unhealthy. */
export const HEALTH_FILE_MAX_AGE_MS = 15_000;

export type LoopHealth = {
  /** Called at every claim-loop turn. */
  progressed(): void;
  /** Called by the heartbeat: refreshes the health file only while the loop turns. */
  report(): Promise<void>;
};

/**
 * Loop-progress heartbeat. `kill -0 1` only proves the process exists; this
 * file proves the claim loop still turns, so a loop wedged on a lock or an
 * exhausted pool turns the container unhealthy while the process lives on.
 */
export function createLoopHealth(file: string | null, now: () => number = Date.now): LoopHealth {
  let lastProgressAt = now();
  let stalled = false;
  let writeFailed = false;

  return {
    progressed() {
      lastProgressAt = now();
    },
    async report() {
      const sinceMs = now() - lastProgressAt;
      if (sinceMs > LOOP_STALL_MS) {
        if (!stalled) logEvent("worker.loop_stalled", { sinceMs }, "error");
        stalled = true;
        return;
      }
      if (stalled) logEvent("worker.loop_recovered", {});
      stalled = false;
      if (!file) return;
      try {
        await writeFile(file, `${new Date(now()).toISOString()}\n`);
        writeFailed = false;
      } catch (error) {
        if (!writeFailed) logEvent("worker.health_file_failed", { error: String(error) }, "error");
        writeFailed = true;
      }
    },
  };
}

export async function isLoopHealthy(file: string, now = Date.now()): Promise<boolean> {
  try {
    return now - (await stat(file)).mtimeMs <= HEALTH_FILE_MAX_AGE_MS;
  } catch {
    return false;
  }
}
