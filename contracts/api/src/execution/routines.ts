import type { WorkflowStatus } from "./runs";

/** Outcomes of a tick, persisted in `routine_executions`. */
const ROUTINE_EXECUTION_OUTCOMES = [
  "fired",
  "catch_up",
  "deferred",
  "abandoned",
  "group_empty",
] as const;

export type RoutineExecutionOutcome = (typeof ROUTINE_EXECUTION_OUTCOMES)[number];

export type RoutineDto = {
  id: string;
  botId: string | null;
  groupId: string | null;
  name: string;
  /** 5-field cron, evaluated in `timezone`. */
  schedule: string;
  timezone: string;
  message: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** Skipped scheduled occurrences (bounded catch-up + exhausted deferrals). */
  missedCount: number;
  lastMissedAt: string | null;
  /**
   * Due, but not fired: the organization's connector is disconnected. The
   * scheduler keeps it due and fires it once (catch-up) when the host is back.
   */
  waitingForHost: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * PERM2-9 « Ne jamais attendre »: an authorization that would wait for a
   * person during a run of this routine is refused at once. True
   * by default for a routine created by the bot.
   */
  neverWait: boolean;
};

/** History row of a routine tick (table `routine_executions`). */
export type RoutineExecutionDto = {
  id: string;
  routineId: string;
  outcome: RoutineExecutionOutcome;
  trigger: "manual" | "scheduled";
  missedCount: number;
  busyRetries: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  workflowId: string | null;
  runId: string | null;
  threadId: string | null;
  workflowStatus: WorkflowStatus | null;
  createdAt: string;
};

export type RoutineExecutionPageDto = {
  executions: RoutineExecutionDto[];
  nextCursor: string | null;
};

export type CreateRoutineInput = {
  name: string;
  schedule: string;
  timezone?: string;
  message: string;
  enabled?: boolean;
  neverWait?: boolean;
};

export type UpdateRoutineInput = Partial<CreateRoutineInput>;

/**
 * Durable acknowledgement of a manual launch. The work stays detached from HTTP:
 * the client then follows the workflow and can use the ordinary
 * stop/reconciliation routes.
 */
export type RoutineRunAcceptedDto = {
  accepted: true;
  /** `true` when the same Idempotency-Key replays the original acknowledgement. */
  duplicate: boolean;
  routineId: string;
  workflowId: string;
  runId: string;
  threadId: string;
  status: "queued";
  notificationEligible: boolean;
  workflowUpdatedAt: string;
};

/** Durable receipt of a routine firing materialized as a workflow. */
export type RoutineExecutionReceiptDto = {
  routineId: string;
  workflowId: string;
  runId: string;
  threadId: string;
  botId: string | null;
  status: WorkflowStatus;
  /** Origin of the firing, read from `recovery_state.trigger`. `null` if absent or unknown. */
  trigger: "manual" | "scheduled" | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
};

export type RoutineExecutionReceiptPageDto = {
  receipts: RoutineExecutionReceiptDto[];
  nextCursor: string | null;
};
