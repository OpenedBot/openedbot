import type { SQL } from "bun";
import { claimReviewGates, reviewGate, type ReviewDeps } from "@openedbot/execution/application/approval-review";
import { createRuntimeClient } from "@openedbot/execution/application/runtime-client";
import { REVIEW_PROFILE } from "@openedbot/runtimes/domain/runtime-contract";
import type { WorkerConfig } from "../config";
import { logEvent } from "@openedbot/platform-observability";

/** Reviews in flight in this worker; each one is bounded by the 15 s budget. */
const MAX_IN_FLIGHT = 8;
const inFlight = new Set<Promise<void>>();

/**
 * PERM2-7: claims gates under review and starts each review without waiting
 * for it, so a slow model never holds the next gate past its budget. A
 * worker that dies mid-review leaves a lease that expires; the next claim
 * takes the gate over, and its budget, counted from the gate's birth, sends
 * it to a human. On a graceful stop, `signal` interrupts the reviews (their
 * gates go to a person) and `track` hands them to the worker's drain, so the
 * database stays open until each one has written its outcome.
 */
export async function processApprovalReviews(
  db: SQL,
  config: WorkerConfig,
  signal?: AbortSignal,
  track?: (review: Promise<void>) => void,
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
    ...(signal ? { signal } : {}),
  };
  for (const job of jobs) {
    const review: Promise<void> = reviewGate(db, job, deps)
      .catch(() => logEvent("approval.review_failed", { runId: job.runId }, "error"))
      .finally(() => { inFlight.delete(review); });
    inFlight.add(review);
    track?.(review);
  }
}

/** For a graceful stop and for tests: the reviews this worker started. */
export function approvalReviewsInFlight(): Promise<unknown> {
  return Promise.allSettled(inFlight);
}
