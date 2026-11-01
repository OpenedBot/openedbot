/**
 * PERM2-7: a gate under automatic review is not in the thread's `approvals`
 * (the API hides it), yet its run already reads `awaiting_approval`. The
 * reviewer settles it within 15 s, either by continuing the run or by handing
 * the gate to a human, and that hand-off may come with no new event on the
 * stream. While a run waits on a gate no card shows, the thread is re-read
 * every `REVIEW_POLL_MS`; after `REVIEW_POLL_WINDOW_MS` on the same runs the
 * fast poll stops, so a run stuck in that state for another reason does not
 * keep the screen polling forever.
 */
export const REVIEW_POLL_MS = 2_000;
export const REVIEW_POLL_WINDOW_MS = 30_000;

export type ReviewPollActivity = {
  runs?: readonly { id: string; status?: string | null }[];
  approvals?: readonly { runId: string; status: string }[];
};

/** The runs waiting on a gate that no card shows, sorted for a stable key. */
export function reviewHeldRunIds(activity: ReviewPollActivity | null | undefined): string[] {
  if (!activity) return [];
  const gated = new Set(
    (activity.approvals ?? []).filter((approval) => approval.status === "pending").map((approval) => approval.runId),
  );
  return (activity.runs ?? [])
    .filter((run) => run.status === "awaiting_approval" && !gated.has(run.id))
    .map((run) => run.id)
    .sort();
}

export type ReviewWatch = { key: string; since: number };

/**
 * One step of the watch: `next` is what to remember, `poll` whether the fast
 * poll applies now. The window restarts when the set of held runs changes.
 */
export function nextReviewWatch(
  previous: ReviewWatch | null,
  activity: ReviewPollActivity | null | undefined,
  now: number,
): { next: ReviewWatch | null; poll: boolean } {
  const held = reviewHeldRunIds(activity);
  if (held.length === 0) return { next: null, poll: false };
  const key = held.join(",");
  const next = previous?.key === key ? previous : { key, since: now };
  return { next, poll: now - next.since < REVIEW_POLL_WINDOW_MS };
}
