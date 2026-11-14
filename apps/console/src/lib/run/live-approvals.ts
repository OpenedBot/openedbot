import type { ApprovalRequestDto, RunDto } from "@openedbot/contracts-api";

const CONCLUDED: ReadonlySet<RunDto["status"]> = new Set(["completed", "failed", "cancelled"]);

/**
 * The gates that STILL await a human decision.
 *
 * The snapshot keeps a `pending` request in the database until it expires
 * (10 minutes) even when its run has finished or been cancelled: without this
 * filter the card stayed displayed under the answer and `pendingGate` kept the
 * composer hidden. A gate is live only if it is `pending` AND its
 * run is not concluded. A run absent from the snapshot concludes nothing: the
 * server remains the source.
 *
 * Returns the input array as-is when nothing is removed: the timeline
 * caches its elements on the identity of `approvals`.
 */
export function liveApprovals(
  approvals: ApprovalRequestDto[],
  runs: readonly Pick<RunDto, "id" | "status">[],
): ApprovalRequestDto[] {
  const live = approvals.filter((approval) => {
    if (approval.status !== "pending") return false;
    const run = runs.find((candidate) => candidate.id === approval.runId);
    return !(run && CONCLUDED.has(run.status));
  });
  return live.length === approvals.length ? approvals : live;
}
