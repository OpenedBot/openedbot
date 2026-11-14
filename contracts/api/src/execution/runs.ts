import type { Usage } from "../shared/domain";

export type ProductRunStatus =
  | "queued"
  | "pending"
  | "starting"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type RunDto = {
  id: string;
  status: ProductRunStatus;
  /**
   * The bot that executes THIS run.
   *
   * Groups: the member whose turn it is. DM: the thread's bot for a
   * `root` step, but the DELEGATED bot for a `delegated` step and the caller for
   * its `continuation`: a DM is not single-speaker since durable
   * workflows. `null` only on legacy hand-off mail.
   */
  botId?: string | null;
  /** The routine that initiated this root turn; internal input is not an operator message. */
  routineId?: string | null;
  input: string;
  output: string | null;
  usage: Usage | null;
  error: string | null;
  /**
   * Stable failure code (`runs.error_code`), for example `MODEL_UNAVAILABLE`
   * when the provider refuses the model (then `model` names the refused
   * model). `error` stays the readable text. Optional: an older API does not
   * carry it.
   */
  errorCode?: string | null;
  hermesResponseId: string | null;
  /**
   * The model that ACTUALLY executed this turn (column `runs.model`), including
   * after a provider fallback. Without it, a thread cannot say
   * which context window applied to the measured turn: the bot's current model
   * is not necessarily the one from three turns ago. Optional: an older API
   * does not carry it.
   */
  model?: string | null;
  runtimeSession: {
    id: string;
    model: string | null;
    reasoningTokens: number | null;
    toolCallCount: number | null;
  } | null;
  /** `bot_greeting` for a new bot's welcome, absent otherwise (the other origins stay internal). */
  origin?: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  lastEventAt: string | null;
  /** Metadata present for a step of a durable autonomous workflow. */
  workflowId?: string | null;
  stepIndex?: number | null;
  stepKind?: "root" | "delegated" | "continuation" | "group" | "memory" | "persona_draft" | "compaction" | null;
  /** Room in team mode: `synthesis` marks the turn that writes the final answer. */
  groupPhase?: "synthesis" | null;
  stackDepth?: number | null;
  completionKind?: string | null;
  /** `needs_review` means the Hermes effect is ambiguous and forbids any blind retry. */
  recoveryState?: "needs_review" | null;
};

export type WorkflowStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "reconciling"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "unknown";

export type WorkflowDto = {
  id: string;
  kind: "dm" | "group" | "routine";
  status: WorkflowStatus;
  rootRunId: string;
  rootBotId: string | null;
  usedSteps: number;
  maxSteps: number;
  usedHandoffs: number;
  maxHandoffs: number;
  usedTokens: number;
  tokenBudget: number;
  deadlineAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  finalOutput?: string | null;
  recoveryState: "needs_review" | null;
  /** Present only when `kind = 'routine'`, extracted from `recovery_state`. */
  routineId?: string | null;
  trigger?: "manual" | "scheduled" | null;
  /** Policy frozen at creation. Older servers may omit it. */
  autonomyEnabled?: boolean;
  /** Durable sequence of the transitions meant for notifications. */
  notificationSequence?: number;
  createdAt: string;
  updatedAt: string;
};
