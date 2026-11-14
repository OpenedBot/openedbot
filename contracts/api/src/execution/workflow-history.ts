import type { WorkflowStatus } from "./runs";
import type { BotFaceSpec } from "../shared/bot-face";

/** One row of the execution history: a workflow, with its context. */
type WorkflowHistoryEntryDto = {
  id: string;
  threadId: string;
  kind: "dm" | "group" | "routine";
  status: WorkflowStatus;
  recoveryState: "needs_review" | null;
  /** Present only when `kind = 'routine'`, extracted from `recovery_state`. */
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
  /** `null` until the execution is closed. */
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
  /** `null` when the last page is reached. */
  nextCursor: string | null;
};
