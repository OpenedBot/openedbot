import type { SQL } from "bun";
import { claimReviewGates, reviewGate, type ReviewDeps } from "@openedbot/execution/application/approval-review";
import { createRuntimeClient } from "@openedbot/execution/application/runtime-client";
import { REVIEW_PROFILE } from "@openedbot/runtimes/domain/runtime-contract";
import type { WorkerConfig } from "../config";

/** Reviews in flight in this worker; each one is bounded by the 15 s budget. */
const MAX_IN_FLIGHT = 8;
const inFlight = new Set<Promise<void>>();

/**
 * PERM2-7: claims gates under review and starts each review without waiting
 * for it, so a slow model never holds the next gate past its budget. A
 * worker that dies mid-review leaves a lease that expires; the next claim
 * takes the gate over, and its budget, counted from the gate's birth, sends
 * it to a human.
 */
export async function processApprovalReviews(
  db: SQL,
  config: WorkerConfig,
  signal?: AbortSignal,
  clientFactory: typeof createRuntimeClient = createRuntimeClient,
): Promise<void> {
  if (signal?.aborted) return;
  const room = MAX_IN_FLIGHT - inFlight.size;
  if (room <= 0) return;
  const jobs = await claimReviewGates(db, room);
  const deps: ReviewDeps = {
    client: (runtime) => clientFactory({ ...runtime, hermesProfile: REVIEW_PROFILE }, config),
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
  };
  for (const job of jobs) {
    const review: Promise<void> = reviewGate(db, job, deps)
      .catch(() => console.error(JSON.stringify({ event: "approval.review_failed", runId: job.runId })))
      .finally(() => { inFlight.delete(review); });
    inFlight.add(review);
  }
}

/** For a graceful stop and for tests: the reviews this worker started. */
export function approvalReviewsInFlight(): Promise<unknown> {
  return Promise.allSettled(inFlight);
}
