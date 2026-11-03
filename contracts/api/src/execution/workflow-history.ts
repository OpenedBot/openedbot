import type { WorkflowStatus } from "./runs";
import type { BotFaceSpec } from "../shared/bot-face";

/** Une ligne de l'historique des exécutions : un workflow, avec son contexte. */
type WorkflowHistoryEntryDto = {
  id: string;
  threadId: string;
  kind: "dm" | "group" | "routine";
  status: WorkflowStatus;
  recoveryState: "needs_review" | null;
  /** Présents seulement quand `kind = 'routine'`, extraits de `recovery_state`. */
  routineId?: string | null;
  trigger?: "manual" | "scheduled" | null;
  usedSteps: number;
  maxSteps: number;
  usedHandoffs: number;
  maxHandoffs: number;
  usedTokens: number;
  tokenBudget: number;
  errorCode: string | null;
  errorMessage: string | null;
  finalOutput: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** `null` tant que l'exécution n'est pas close. */
  durationMs: number | null;
  botName: string | null;
  botSlug: string | null;
  botFace: BotFaceSpec | null;
  groupId: string | null;
  groupName: string | null;
  initiatorName: string | null;
};

export type WorkflowHistoryPageDto = {
  workflows: WorkflowHistoryEntryDto[];
  /** `null` quand la dernière page est atteinte. */
  nextCursor: string | null;
};
