import { asRecord } from "@openedbot/contracts-primitives";
import { isTodoTool, readAgentToolCall } from "./agent-tool-call";

/**
 * Projection du plan Hermes à partir du transcript du tour.
 *
 * Le flux SSE Hermes expose le nom et le résumé des outils, mais pas leurs
 * arguments. Le transcript contient, lui, les `tool_calls` complets.
 * On reconstruit donc ici le plan du seul outil `todo` à partir du transcript
 * relu après chaque `tool.completed` de `todo` pendant le run, puis à nouveau
 * à `run.completed`, depuis le transcript livré ou relu à la clôture du run.
 */

export type AgentPlanStepStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type AgentPlanStep = {
  id: string;
  content: string;
  status: AgentPlanStepStatus;
};

export type AgentPlan = {
  steps: AgentPlanStep[];
};

type JsonRecord = Record<string, unknown>;

function parseArguments(value: unknown): JsonRecord | null {
  const record = asRecord(value);
  if (record) return record;
  if (typeof value !== "string") return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function normalizeStatus(value: unknown): AgentPlanStepStatus {
  return value === "in_progress" || value === "completed" || value === "cancelled"
    ? value
    : "pending";
}

export function isAgentPlan(value: unknown): value is AgentPlan {
  const plan = asRecord(value);
  return Boolean(
    plan &&
    Array.isArray(plan.steps) &&
    plan.steps.every((step) => {
      const item = asRecord(step);
      return Boolean(
        item &&
        typeof item.id === "string" &&
        typeof item.content === "string" &&
        (item.status === "pending" ||
          item.status === "in_progress" ||
          item.status === "completed" ||
          item.status === "cancelled"),
      );
    }),
  );
}

function normalizeStep(value: unknown, fallbackIndex: number): AgentPlanStep | null {
  const item = asRecord(value);
  if (!item) return null;
  const content = typeof item.content === "string" ? item.content.trim() : "";
  if (!content) return null;
  const id = typeof item.id === "string" && item.id.trim()
    ? item.id.trim()
    : `step-${fallbackIndex + 1}`;
  return { id, content, status: normalizeStatus(item.status) };
}

function mergeStep(current: AgentPlanStep | undefined, value: unknown, fallbackIndex: number): AgentPlanStep | null {
  const item = asRecord(value);
  if (!item) return null;
  const id = typeof item.id === "string" && item.id.trim()
    ? item.id.trim()
    : current?.id ?? `step-${fallbackIndex + 1}`;
  const content = typeof item.content === "string" && item.content.trim()
    ? item.content.trim()
    : current?.content;
  if (!content) return null;
  return {
    id,
    content,
    status: "status" in item ? normalizeStatus(item.status) : current?.status ?? "pending",
  };
}

function readTodoCall(call: unknown): { todos: unknown[]; merge: boolean } | null {
  const normalized = readAgentToolCall(call);
  if (!normalized || !isTodoTool(normalized.name)) return null;
  const args = parseArguments(normalized.arguments);
  if (!args || !Array.isArray(args.todos)) return null;
  return { todos: args.todos, merge: args.merge === true };
}

/**
 * Rejoue les écritures `todo` dans l'ordre du transcript Hermes.
 *
 * La sémantique est volontairement celle du runtime : remplacement complet
 * par défaut, puis mise à jour par id avec `merge: true`. Les appels de
 * lecture (`todo` sans `todos`) n'ont aucun effet sur la projection.
 */
export function projectAgentPlan(messages: unknown): AgentPlan | null {
  if (!Array.isArray(messages)) return null;
  const steps = new Map<string, AgentPlanStep>();
  let sawTodoWrite = false;

  for (const message of messages) {
    const messageRecord = asRecord(message);
    if (!messageRecord || messageRecord.role !== "assistant") continue;
    const calls = Array.isArray(messageRecord.tool_calls) ? messageRecord.tool_calls : [];
    for (const call of calls) {
      const todo = readTodoCall(call);
      if (!todo) continue;
      sawTodoWrite = true;

      if (!todo.merge) steps.clear();
      todo.todos.forEach((value, index) => {
        const item = asRecord(value);
        const id = typeof item?.id === "string" && item.id.trim() ? item.id.trim() : `step-${index + 1}`;
        const normalized = todo.merge
          ? mergeStep(steps.get(id), value, index)
          : normalizeStep(value, index);
        if (normalized) steps.set(normalized.id, normalized);
      });
    }
  }

  const ordered = [...steps.values()];
  const activeIndex = ordered.findIndex((step) => step.status === "in_progress");
  const pendingIndex = activeIndex === -1
    ? -1
    : ordered.slice(0, activeIndex).findIndex((step) => step.status === "pending");
  if (activeIndex !== -1 && pendingIndex !== -1) {
    const [active] = ordered.splice(activeIndex, 1);
    ordered.splice(pendingIndex, 0, active!);
  }
  return sawTodoWrite ? { steps: ordered.slice(0, 256) } : null;
}
