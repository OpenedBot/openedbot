import { ConfigError, type E2eConfig } from "./config";
import type { Scenario } from "./scenario";
import { coordination } from "../scenarios/coordination";
import { fastPath } from "../scenarios/fast-path";
import { greeting } from "../scenarios/greeting";
import { lifecycle } from "../scenarios/lifecycle";
import { modelReset } from "../scenarios/model-reset";
import { permissions } from "../scenarios/permissions";
import { concurrencyIdempotency } from "../scenarios/concurrency-idempotency";
import { toolExecution } from "../scenarios/tool-execution";
import { browserAction } from "../scenarios/browser-action";
import { profileIsolation } from "../scenarios/profile-isolation";
import { interruptRecovery } from "../scenarios/interrupt-recovery";
import { memoryRecall } from "../scenarios/memory-recall";
import { skillsMcp } from "../scenarios/skills-mcp";
import { chatReminders } from "../scenarios/chat-reminders";
import { routines } from "../scenarios/routines";
import { attachmentsContext } from "../scenarios/attachments-context";
import { coordinationFailures } from "../scenarios/coordination-failures";

export const P0: Scenario[] = [toolExecution, browserAction, concurrencyIdempotency, interruptRecovery, profileIsolation];
export const P1: Scenario[] = [memoryRecall, skillsMcp, routines, chatReminders, attachmentsContext, coordinationFailures];
const LEGACY = [lifecycle, greeting, fastPath, coordination, modelReset, permissions];
const ALL = [...LEGACY, ...P0, ...P1];
const SUITES: Record<string, Scenario[]> = { p0: P0, p1: P1, acceptance: [...P0, ...P1], all: ALL };

export const isAcceptance = (scenario: Scenario): boolean => P0.includes(scenario) || P1.includes(scenario);

export function enforceAcceptanceTarget(config: E2eConfig, scenarios: Scenario[]): void {
  if (!scenarios.some(isAcceptance)) return;
  config.strict = true;
  if (!config.expectedRuntimeId) throw new ConfigError("Acceptance suites require E2E_RUNTIME_ID naming the intended lab runtime.");
  if (config.keep) throw new ConfigError("Acceptance suites require verified cleanup: --keep is not allowed.");
}

export function pickScenarios(names: string[]): Scenario[] {
  const selected = names.flatMap((name) => {
    const suite = Object.hasOwn(SUITES, name) ? SUITES[name] : undefined;
    const scenario = ALL.find((entry) => entry.id === name);
    if (!suite && !scenario) throw new ConfigError(`Unknown scenario "${name}". Known: ${ALL.map((entry) => entry.id).join(", ")}, ${Object.keys(SUITES).join(", ")}.`);
    return suite ?? [scenario!];
  });
  return [...new Set(selected)];
}
