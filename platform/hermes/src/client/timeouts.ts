import type { HermesClientTimeouts } from "../contracts";

/** The timeouts a client applies when its config does not override them. */
export const HERMES_DEFAULT_TIMEOUTS: Readonly<HermesClientTimeouts> = {
  createRunMs: 30_000,
  runStatusMs: 5_000,
  sessionCountersMs: 5_000,
  sessionMessagesMs: 8_000,
  mutationMs: 10_000,
};

const MAX_TIMEOUT_MS = 10 * 60_000;

function boundedTimeout(value: number | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

/** Overrides from the config, each one bounded to a safe integer of at most 10 minutes. */
export function resolveHermesTimeouts(overrides: Partial<HermesClientTimeouts> | undefined): HermesClientTimeouts {
  return {
    createRunMs: boundedTimeout(overrides?.createRunMs, HERMES_DEFAULT_TIMEOUTS.createRunMs),
    runStatusMs: boundedTimeout(overrides?.runStatusMs, HERMES_DEFAULT_TIMEOUTS.runStatusMs),
    sessionCountersMs: boundedTimeout(overrides?.sessionCountersMs, HERMES_DEFAULT_TIMEOUTS.sessionCountersMs),
    sessionMessagesMs: boundedTimeout(overrides?.sessionMessagesMs, HERMES_DEFAULT_TIMEOUTS.sessionMessagesMs),
    mutationMs: boundedTimeout(overrides?.mutationMs, HERMES_DEFAULT_TIMEOUTS.mutationMs),
  };
}
