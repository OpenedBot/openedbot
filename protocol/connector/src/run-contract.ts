/** Gateway payload contract, derived from cloud readers and the fake gateway.
 * Unknown fields are allowed, as in the relay codec. No production caller uses
 * these validators: fixtures pin the boundary without changing runtime behavior.
 */
import routes from "../fixtures/run-contract.routes.json";

export const RUN_CONTRACT_ROUTES = routes;
export const RUN_EVENT_TYPES = [
  "message.delta", "tool.started", "tool.completed", "approval.request", "approval.responded",
  "run.completed", "run.failed", "run.error", "run.interrupted", "run.cancelled",
  "message.interim", "reasoning.available",
] as const;
export const RUN_STATUSES = [
  "queued", "started", "running", "stopping", "waiting_for_approval", "completed",
  "failed", "interrupted", "cancelled", "unknown",
] as const;
const choices = ["once", "session", "always", "deny"];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const generation = (v: unknown): boolean => number(v) && Number.isSafeInteger(v);
const optional = (v: unknown, check: (v: unknown) => boolean): boolean => v === undefined || check(v);
const nullableText = (v: unknown): boolean => v === null || typeof v === "string";
const strings = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === "string");
const usage = (v: unknown): boolean => v === null || (object(v) &&
  ["input_tokens", "output_tokens", "total_tokens"].every((key) => optional(v[key], number)));
const identity = (v: unknown): boolean => text(v) && v.length <= 256;
const toolId = (v: unknown): boolean => text(v) && v.length <= 200;

/** Both request matching and the strict fake use the same method/path list. */
export function runContractRoute(method: string, path: string): typeof routes[number] | undefined {
  const pathname = path.split("?")[0]!.replace(/^\/p\/[a-z0-9_-]+/i, "");
  return routes.find((route) => route.method === method &&
    new RegExp(`^${route.path.replace(/\{(?:id|slug|file)\}/g, "[^/]+")}$`).test(pathname));
}

export function isRunContractEvent(value: unknown): boolean {
  if (!object(value) || !text(value.run_id) || !(typeof value.timestamp === "number" && Number.isFinite(value.timestamp)) ||
    !RUN_EVENT_TYPES.includes(value.event as typeof RUN_EVENT_TYPES[number])) return false;
  const v = value;
  switch (v.event) {
    case "message.delta": return typeof v.delta === "string";
    case "tool.started": return text(v.tool) && optional(v.tool_call_id, toolId) && optional(v.preview, nullableText);
    case "tool.completed": return text(v.tool) && optional(v.tool_call_id, toolId) &&
      optional(v.duration, number) && optional(v.error, (x) => typeof x === "boolean" || typeof x === "string") &&
      ["preview", "error_message", "errorMessage", "message"].every((key) => optional(v[key], nullableText)) &&
      optional(v.result, (x) => x === null || typeof x === "string" || object(x));
    case "approval.request": return (identity(v.prompt_id) || identity(v.request_id)) &&
      optional(v.execution_generation, generation) && typeof v.command === "string" &&
      typeof v.description === "string" && Array.isArray(v.choices) &&
      v.choices.every((c) => choices.includes(c as string)) &&
      optional(v.pattern_key, (x) => typeof x === "string") && optional(v.pattern_keys, strings);
    case "approval.responded": return choices.includes(v.choice as string) && optional(v.resolved, number);
    case "run.completed": return optional(v.output, nullableText) && optional(v.usage, usage) &&
      optional(v.messages, Array.isArray) && optional(v.pending_steer, nullableText);
    case "run.failed":
    case "run.error": return optional(v.message, nullableText) && optional(v.error, nullableText);
    default: return true;
  }
}

export type RunContractPayload = "event" | "run-create" | "run-status" | "approval" |
  "session-create" | "session-created" | "capabilities" | "toolsets" | "model-options";

export function isRunContractPayload(kind: RunContractPayload, value: unknown): boolean {
  if (kind === "event") return isRunContractEvent(value);
  if (!object(value)) return false;
  const v = value;
  switch (kind) {
    case "run-create": return text(v.run_id);
    case "run-status": return RUN_STATUSES.includes(v.status as typeof RUN_STATUSES[number]) &&
      optional(v.run_id, text) && optional(v.output, nullableText) &&
      (v.status !== "completed" || typeof v.output === "string") && optional(v.usage, usage) &&
      optional(v.admission_id, identity) && optional(v.execution_generation, generation) && optional(v.pending_steer, nullableText);
    case "approval": return identity(v.request_id) && choices.includes(v.choice as string) &&
      (v.execution_generation === undefined
        ? typeof v.approved === "boolean" && v.approved === (v.choice !== "deny")
        : generation(v.execution_generation) && Object.keys(v).every((key) => ["request_id", "execution_generation", "choice"].includes(key)));
    case "session-create": return text(v.id) && typeof v.title === "string";
    case "session-created": return text(v.id);
    case "capabilities": return optional(v.features, (x) => object(x) &&
      optional(x.max_concurrent_runs, number) && ["run_steer", "event_replay"].every((key) =>
        optional(x[key], (flag) => typeof flag === "boolean"))) && optional(v.endpoints, (x) => object(x) &&
      Object.values(x).every((endpoint) => object(endpoint) && text(endpoint.method) && text(endpoint.path))) &&
      optional(v.max_concurrent_runs, number);
    case "toolsets": return Array.isArray(v.data) && v.data.every((item) => object(item) && text(item.name) &&
      optional(item.enabled, (x) => typeof x === "boolean") && optional(item.configured, (x) => typeof x === "boolean") &&
      optional(item.label, nullableText) && optional(item.description, nullableText) && optional(item.tools, strings));
    case "model-options": return optional(v.provider, nullableText) && optional(v.model, nullableText) &&
      Array.isArray(v.providers) && v.providers.every((item) => object(item) && typeof item.slug === "string" &&
        typeof item.name === "string" && optional(item.models, strings) && optional(item.capabilities, (x) => object(x) &&
          Object.values(x).every((detail) => object(detail) && ["fast", "reasoning"].every((key) =>
            optional(detail[key], (flag) => typeof flag === "boolean")))) &&
        ["authenticated", "is_current"].every((key) => optional(item[key], (x) => typeof x === "boolean")) &&
        optional(item.auth_type, nullableText) && optional(item.warning, nullableText));
  }
}
