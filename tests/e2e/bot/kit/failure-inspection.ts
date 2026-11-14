import { lstat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export type FailureInspection = { scenario: string; runtime: string; labTag: string; outDir: string; milliseconds: number; caseKey?: object };
type InspectionReason = "configuration" | "filesystem" | "clock" | "sleep" | "logging";
class InspectionFailure extends Error { constructor(readonly reason: InspectionReason) { super("Failure inspection unavailable."); } }
type Identity = { scenario: string; runtime: string; labTag: string; releasePath: string | null };
export type InspectionDependencies = {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  prepare(directory: string): Promise<void>;
  released(path: string): Promise<boolean>;
  log(event: string, identity: Identity & { reason?: InspectionReason }): void;
};
const inspectedCases = new WeakSet<object>();
const defaults: InspectionDependencies = {
  now: () => performance.now(), sleep: (milliseconds) => Bun.sleep(milliseconds),
  prepare: async (directory) => { await mkdir(directory, { recursive: true }); },
  released: async (path) => {
    try { return (await lstat(path)).isFile(); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; }
  },
  log: (event, identity) => console.log(JSON.stringify({ event: `e2e.${event}`, ...identity })),
};
const scenarioId = /^[a-z0-9][a-z0-9-]{0,63}$/;
const runtimeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const labTag = /^[a-f0-9]{6}$/;
function identity(input: FailureInspection): Identity {
  return { scenario: scenarioId.test(input.scenario) ? input.scenario : "invalid",
    runtime: runtimeId.test(input.runtime) ? input.runtime : "invalid", labTag: labTag.test(input.labTag) ? input.labTag : "invalid",
    releasePath: scenarioId.test(input.scenario) ? resolve(input.outDir, `inspection-${input.scenario}.release`) : null };
}

/** Manual debugging only: no assertion retry, host action or evidence mutation. */
export async function waitForFailureInspection(input: FailureInspection, dependencies = defaults): Promise<void> {
  if (input.milliseconds === 0) return;
  if (!Number.isInteger(input.milliseconds) || input.milliseconds < 0 || input.milliseconds > 120_000) throw new Error("Invalid failure inspection duration.");
  const fields = identity(input);
  if (fields.scenario === "invalid" || fields.runtime === "invalid" || fields.labTag === "invalid" || !fields.releasePath) throw new Error("Invalid failure inspection identity.");
  if (input.caseKey) {
    if (inspectedCases.has(input.caseKey)) return;
    inspectedCases.add(input.caseKey);
  }
  let phase: InspectionReason = "filesystem";
  try {
    await dependencies.prepare(resolve(input.outDir));
    phase = "clock";
    const deadline = dependencies.now() + input.milliseconds;
    phase = "logging";
    dependencies.log("failure_inspection_started", fields);
    while (true) {
      phase = "clock";
      if (dependencies.now() >= deadline) break;
      phase = "filesystem";
      if (await dependencies.released(fields.releasePath)) {
        phase = "logging"; dependencies.log("failure_inspection_released", fields); return;
      }
      phase = "clock";
      const remaining = deadline - dependencies.now();
      if (remaining > 0) { phase = "sleep"; await dependencies.sleep(Math.min(250, remaining)); }
    }
    phase = "logging";
    dependencies.log("failure_inspection_expired", fields);
  } catch { throw new InspectionFailure(phase); }
}

/** Optional diagnostic failure never replaces the primary scenario failure. */
export async function inspectFailure(input: FailureInspection, dependencies = defaults): Promise<void> {
  try { await waitForFailureInspection(input, dependencies); }
  catch (failure) { dependencies.log("failure_inspection_failed", { ...identity(input), reason: failure instanceof InspectionFailure ? failure.reason : "configuration" }); }
}

/** Purge survives inspection filesystem, clock, logger and sleep failures. */
export async function inspectionBeforePurge(primaryFailed: boolean, input: FailureInspection, purge: () => Promise<void>, dependencies = defaults): Promise<void> {
  try { if (primaryFailed) await inspectFailure(input, dependencies); }
  finally { await purge(); }
}
