import type { RunDto, WorkflowDto, WorkflowStatus } from "@openedbot/contracts-api";

/**
 * Un workflow encore en vol : c'est le seul cas où l'état durable APPREND
 * quelque chose que le fil ne dit pas déjà (progression, deadline, étapes).
 */
const IN_FLIGHT: ReadonlySet<WorkflowStatus> = new Set([
  "queued",
  "running",
  "awaiting_approval",
  "reconciling",
]);

/**
 * Un workflow terminé, échoué, annulé ou expiré n'apprend plus rien : le fil
 * porte déjà sa réponse, son erreur ou sa notice d'annulation. `unknown` n'est
 * PAS de ceux-là : l'effet externe reste à établir.
 */
const SETTLED: ReadonlySet<WorkflowStatus> = new Set(["completed", "failed", "cancelled", "expired"]);

/** Ce que la règle d'affichage lit d'un workflow : jamais un écran, jamais un DTO complet. */
export type WorkflowDisplayState = Pick<WorkflowDto, "status" | "recoveryState">;

export const isWorkflowInFlight = (workflow: Pick<WorkflowDto, "status">): boolean =>
  IN_FLIGHT.has(workflow.status);

/**
 * LA règle d'affichage de l'état durable pour la PWA (`workflow-overview.tsx`) :
 * ne reste que ce que le fil ne sait pas dire : un workflow encore en vol, ou
 * un workflow dont l'issue reste à trancher par un opérateur (`needs_review`,
 * atteignable même après un état terminal).
 */
export const isWorkflowWorthShowing = (workflow: WorkflowDisplayState): boolean =>
  !SETTLED.has(workflow.status) || workflow.recoveryState === "needs_review";

/** Le même prédicat, appliqué aux groupes de `groupWorkflowRuns`. */
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
