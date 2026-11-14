import type { HermesPromptCacheTtl } from "@openedbot/hermes";
import { BASELINE_REQUIRED_FEATURES, CAPABILITY_BASELINE_VERSION } from "@openedbot/roster/domain/capability-baseline";

/**
 * Steps no person paces: a bot called by another, the caller resumed, and
 * the maintenance turns (memory, persona draft, compaction).
 */
const MACHINE_STEP_KINDS: ReadonlySet<string> = new Set(["delegated", "continuation", "memory", "persona_draft", "compaction"]);

export type PromptCacheTierInput = {
  origin: string | null;
  originRunId: string | null;
  stepKind: string | null;
  workflowKind: string | null;
  hermesProfileManaged: boolean;
  linkFeatures: readonly string[];
  capabilityBaselineVersion: number | null;
};

/**
 * The prompt-cache tier a run asks for, or `null` for the runtime's own
 * (edge-setup: `auto`, so `1h` for an API run). A `1h` write costs 2x the
 * input price against 1.25x for `5m`, and pays only when the same prefix is
 * read again after more than 5 minutes, which a person pausing in a chat does.
 *
 * `5m` for a run nobody paces (a routine, a greeting, a delegated or
 * maintenance step, an incoming hand-off) and for a new bot whose capability
 * baseline is still to come: its tool list, and with it the whole cached
 * prefix, changes once the baseline lands, so a `1h` write is billed for
 * nothing.
 */
export function promptCacheTierForRun(run: PromptCacheTierInput): HermesPromptCacheTtl | null {
  if (run.origin === "bot_greeting" || run.originRunId !== null) return "5m";
  if (run.workflowKind === "routine") return "5m";
  if (run.stepKind !== null && MACHINE_STEP_KINDS.has(run.stepKind)) return "5m";
  if (baselinePending(run)) return "5m";
  return null;
}

/** Same terms as the worker's baseline: a managed profile on a runtime with the baseline verbs. */
function baselinePending(run: PromptCacheTierInput): boolean {
  if (!run.hermesProfileManaged) return false;
  if (!BASELINE_REQUIRED_FEATURES.every((feature) => run.linkFeatures.includes(feature))) return false;
  return (run.capabilityBaselineVersion ?? 0) < CAPABILITY_BASELINE_VERSION;
}
