/**
 * How long a workflow that never started may wait in the queue.
 *
 * `workflows.deadline_at` is set when the workflow is queued (creation, or a
 * steer fallback reactivated), to `queued at + timeout_seconds`. It bounds the
 * EXECUTION. Used alone as the claim guard, it also bounded the wait: a
 * workflow waiting for capacity or for a runtime (link cut) expired with
 * `WORKFLOW_DEADLINE_EXCEEDED` before running a single step. Reported by
 * Anthony Ringard (PR #61); seen here on run `db0241ca`.
 *
 * A workflow whose `started_at` is null may therefore be claimed until
 * `queued at + WORKFLOW_ADMISSION_GRACE_SECONDS` (never earlier than its own
 * deadline), and the runner gives it a fresh execution budget when it really
 * starts. Once started, `deadline_at` alone decides, as before: a queued step
 * of a started workflow (continuation, worker crash before the Hermes create)
 * still expires on it.
 *
 * The queue (`queue.ts`) and the sweep (`queue-sweeps.ts`) write the same rule
 * in SQL; `workflowAdmissionDeadline` is its reading, for the tests.
 */
export const WORKFLOW_ADMISSION_GRACE_SECONDS = 2 * 60 * 60;

export function workflowAdmissionDeadline(workflow: {
  startedAt: Date | string | null;
  deadlineAt: Date | string;
  timeoutSeconds: number;
}): Date {
  const deadline = new Date(workflow.deadlineAt).getTime();
  if (workflow.startedAt !== null) return new Date(deadline);
  const queuedAt = deadline - workflow.timeoutSeconds * 1_000;
  return new Date(Math.max(deadline, queuedAt + WORKFLOW_ADMISSION_GRACE_SECONDS * 1_000));
}
