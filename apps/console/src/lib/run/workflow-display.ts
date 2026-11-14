import type { RunDto, WorkflowDto, WorkflowStatus } from "@openedbot/contracts-api";

/**
 * A workflow still in flight: this is the only case where the durable state LEARNS
 * something the thread does not already say (progress, deadline, steps).
 */
const IN_FLIGHT: ReadonlySet<WorkflowStatus> = new Set([
  "queued",
  "running",
  "awaiting_approval",
  "reconciling",
]);

/**
 * A completed, failed, cancelled or expired workflow no longer teaches anything: the thread
 * already carries its answer, its error or its cancellation notice. `unknown` is
 * NOT one of those: the external effect remains to be established.
 */
const SETTLED: ReadonlySet<WorkflowStatus> = new Set(["completed", "failed", "cancelled", "expired"]);

/** What the display rule reads from a workflow: never a screen, never a full DTO. */
export type WorkflowDisplayState = Pick<WorkflowDto, "status" | "recoveryState">;

export const isWorkflowInFlight = (workflow: Pick<WorkflowDto, "status">): boolean =>
  IN_FLIGHT.has(workflow.status);

/**
 * THE display rule for durable state in the PWA (`workflow-overview.tsx`):
 * only what the thread cannot say remains: a workflow still in flight, or
 * a workflow whose outcome still has to be decided by an operator (`needs_review`,
 * reachable even after a terminal state).
 */
export const isWorkflowWorthShowing = (workflow: WorkflowDisplayState): boolean =>
  !SETTLED.has(workflow.status) || workflow.recoveryState === "needs_review";

/** The same predicate, applied to the groups of `groupWorkflowRuns`. */
export function visibleWorkflowGroups(
  groups: readonly WorkflowRunGroup[],
): WorkflowRunGroup[] {
  return groups.filter(({ workflow }) => isWorkflowWorthShowing(workflow));
}

export type WorkflowRunGroup = {
  workflow: WorkflowDto;
  steps: RunDto[];
  /** Last successful output once the durable workflow itself is complete. */
  finalRun: RunDto | null;
  finalOutput: string | null;
};

/** PostgreSQL bigint counters may cross HTTP as decimal strings. */
export function normalizeWorkflowCounters(workflow: WorkflowDto): WorkflowDto {
  return {
    ...workflow,
    usedTokens: Number(workflow.usedTokens),
    tokenBudget: Number(workflow.tokenBudget),
  };
}

/** Groups snapshot runs deterministically without trusting arrival order. */
export function groupWorkflowRuns(
  workflows: readonly WorkflowDto[],
  runs: readonly RunDto[],
): WorkflowRunGroup[] {
  const byWorkflow = new Map<string, RunDto[]>();
  for (const run of runs) {
    if (!run.workflowId) continue;
    const bucket = byWorkflow.get(run.workflowId) ?? [];
    bucket.push(run);
    byWorkflow.set(run.workflowId, bucket);
  }

  return workflows.map((workflow) => {
    const steps = [...(byWorkflow.get(workflow.id) ?? [])].sort(compareSteps);
    const explicitFinalRun = [...steps].reverse().find(
      (run) => run.completionKind === "final" && run.status === "completed" && Boolean(run.output?.trim()),
    ) ?? null;
    const hasExplicitFinalContract = Object.hasOwn(workflow, "finalOutput") ||
      steps.some((run) => Object.hasOwn(run, "completionKind"));
    const compatibilityFinalRun = workflow.status === "completed" && !hasExplicitFinalContract
      ? [...steps].reverse().find((run) => run.status === "completed" && Boolean(run.output?.trim())) ?? null
      : null;
    const finalRun = explicitFinalRun ?? compatibilityFinalRun;
    const finalOutput = workflow.finalOutput?.trim() || finalRun?.output?.trim() || null;
    return { workflow, steps, finalRun, finalOutput };
  });
}

function compareSteps(left: RunDto, right: RunDto): number {
  const leftIndex = left.stepIndex ?? Number.MAX_SAFE_INTEGER;
  const rightIndex = right.stepIndex ?? Number.MAX_SAFE_INTEGER;
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  const byDate = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return Number.isFinite(byDate) && byDate !== 0 ? byDate : left.id.localeCompare(right.id);
}
