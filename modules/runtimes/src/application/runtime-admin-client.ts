import { HermesClient, type HermesClientConfig } from "@openedbot/hermes";

/**
 * The verbs of a turn on Hermes: opening a session, creating a run, reading its
 * status or stream, answering its approvals, steering and stopping it. They
 * belong to the worker, which holds the run's lease; an API
 * process never calls them. `tests/scripts/runtime-client-contract.ts` keeps
 * this list in step with `HermesClient`.
 */
export const RUNTIME_EXECUTION_VERBS = [
  "ensureSession",
  "createRun",
  "getRunStatus",
  "events",
  "steerRun",
  "stopRun",
  "respondApproval",
  "resolveUnknownRun",
] as const;

export type RuntimeExecutionVerb = (typeof RUNTIME_EXECUTION_VERBS)[number];

/** Reads and administration of a runtime (models, usage, context, inventory, MCP, OAuth, profiles…). */
export type RuntimeAdminClient = Omit<HermesClient, RuntimeExecutionVerb>;

const EXECUTION_VERBS: ReadonlySet<string> = new Set(RUNTIME_EXECUTION_VERBS);

/**
 * The only Hermes client the API builds: synchronous reads and administration
 * of the runtime. An execution verb is absent from the type and refused at
 * call time, so a cast cannot turn an API route into a run: a mutation of
 * execution is a durable command executed by the worker.
 */
export function runtimeAdminClient(config: HermesClientConfig): RuntimeAdminClient {
  const client = new HermesClient(config);
  return new Proxy(client, {
    get(target, property, receiver) {
      if (typeof property === "string" && EXECUTION_VERBS.has(property)) {
        return () => {
          const error = new Error(`${property} is an execution verb: the worker runs it, never the API.`);
          error.name = "RUNTIME_EXECUTION_FORBIDDEN";
          throw error;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
