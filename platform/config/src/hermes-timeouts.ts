import type { HermesClientTimeouts } from "@openedbot/hermes";

/**
 * The `HERMES_*_TIMEOUT_MS` variables as Hermes client timeouts. The client
 * never reads the environment: the process entry points (API, worker) read it
 * once here and hand the result to `new HermesClient({ ..., timeouts })`.
 * Unset variables stay absent so the client keeps its defaults; a malformed or
 * out-of-range value falls back to the default inside the client.
 */
export function readHermesTimeouts(env: Record<string, string | undefined>): Partial<HermesClientTimeouts> {
  const timeouts: Partial<HermesClientTimeouts> = {};
  const read = (key: keyof HermesClientTimeouts, raw: string | undefined) => {
    if (raw !== undefined) timeouts[key] = Number(raw);
  };
  read("createRunMs", env.HERMES_CREATE_TIMEOUT_MS);
  read("runStatusMs", env.HERMES_STATUS_TIMEOUT_MS);
  read("sessionCountersMs", env.HERMES_SESSION_TIMEOUT_MS);
  read("sessionMessagesMs", env.HERMES_SESSION_MESSAGES_TIMEOUT_MS);
  read("mutationMs", env.HERMES_MUTATION_TIMEOUT_MS);
  return timeouts;
}
