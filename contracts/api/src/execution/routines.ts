import type { WorkflowStatus } from "./runs";

/** Issues d'un tick, persistées dans `routine_executions`. */
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
  /** Cron 5 champs, évalué dans `timezone`. */
  schedule: string;
  timezone: string;
  message: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** Occurrences planifiées sautées (catch-up borné + reports épuisés). */
  missedCount: number;
  lastMissedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * PERM2-9 « Ne jamais attendre » : une autorisation qui attendrait une
   * personne pendant un run de cette routine est refusée tout de suite. Vrai
   * par défaut pour une routine créée par le bot.
   */
  neverWait: boolean;
};

/** Ligne d'historique d'un tick de routine (table `routine_executions`). */
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
 * Accusé durable d'un lancement manuel. Le travail reste détaché du HTTP :
 * le client suit ensuite le workflow et peut utiliser les routes ordinaires
 * d'arrêt/réconciliation.
 */
export type RoutineRunAcceptedDto = {
  accepted: true;
  /** `true` quand la même Idempotency-Key rejoue l'accusé original. */
  duplicate: boolean;
  routineId: string;
  workflowId: string;
  runId: string;
  threadId: string;
  status: "queued";
  notificationEligible: boolean;
  workflowUpdatedAt: string;
};

/** Reçu durable d'un tir de routine matérialisé en workflow. */
export type RoutineExecutionReceiptDto = {
  routineId: string;
  workflowId: string;
  runId: string;
  threadId: string;
  botId: string | null;
  status: WorkflowStatus;
  /** Provenance du tir, lue dans `recovery_state.trigger`. `null` si absente ou inconnue. */
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
