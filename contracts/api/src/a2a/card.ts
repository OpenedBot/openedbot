import type { A2aAgentCard } from "@openedbot/contracts-connector/a2a";

export type { A2aAgentCard } from "@openedbot/contracts-connector/a2a";

export type A2aCardReadDto = {
  state: "available" | "unsupported" | "unavailable" | "no_runtime";
  runtimeId: string | null;
  observedAt: string;
  card: A2aAgentCard | null;
};
