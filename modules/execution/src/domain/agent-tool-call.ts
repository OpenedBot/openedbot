import { asRecord } from "@openedbot/contracts-primitives";

const TODO_TOOL_NAMES: ReadonlySet<string> = new Set(["todo", "todo_list"]);

export type AgentToolCall = {
  name: string;
  arguments: unknown;
};

/** Hermes names the current Todo tool `todo_list` and keeps `todo` in replayed history. */
export function isTodoTool(name: unknown): name is string {
  return typeof name === "string" && TODO_TOOL_NAMES.has(name);
}

/** Reads OpenAI-style calls and unwraps a single-call tool-search bridge. */
export function readAgentToolCall(call: unknown): AgentToolCall | null {
  const record = asRecord(call);
  if (!record) return null;
  const fn = asRecord(record.function);
  const name = typeof record.name === "string"
    ? record.name
    : typeof fn?.name === "string" ? fn.name : null;
  if (!name) return null;
  const args = "arguments" in record ? record.arguments : fn?.arguments;
  if (name !== "tool_call") return { name, arguments: args };

  const bridge = parseArguments(args);
  const calls = bridge?.calls;
  if (!Array.isArray(calls) || calls.length !== 1) return null;
  const nested = readAgentToolCall(calls[0]);
  return nested && nested.name !== "tool_call" ? nested : null;
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (record) return record;
  if (typeof value !== "string") return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}
