import type { SQL } from "bun";
import type { Db } from "@openedbot/platform-db";
import { createRuntimeClient } from "@openedbot/execution/application/runtime-client";
import { withProfileNamesLock } from "@openedbot/roster/application/profile-import-guard";
import { PROFILE_SERVE_WAIT } from "@openedbot/roster/application/profile-provisions";
import { prepareReviewProfile } from "@openedbot/runtimes/application/review-profile";
import { REVIEW_PROFILE } from "@openedbot/runtimes/domain/runtime-contract";
import { claimReviewProfile, enqueueReviewProfiles, finishReviewProfile, type ReviewProfileJob } from "@openedbot/runtimes/application/review-profile";
import type { WorkerConfig } from "../config";
import { logEvent } from "@openedbot/platform-observability";

/**
 * PERM2-7a: one runtime per pass. The review profile of every active
 * connector runtime of a `v2` organization is prepared, then proven again
 * every two minutes; until it is, `auto` behaves as `manual` there.
 */
export async function processReviewProfiles(
  db: SQL,
  config: WorkerConfig,
  signal?: AbortSignal,
  clientFactory: typeof createRuntimeClient = createRuntimeClient,
): Promise<void> {
  if (signal?.aborted) return;
  await enqueueReviewProfiles(db);
  const job = await claimReviewProfile(db, config.workerId);
  if (!job) return;
  const started = Date.now();
  const client = (profile: string | null) => clientFactory({
    runtimeId: job.runtime_id,
    reachability: "connector",
    runtimeEndpoint: null,
    tokenCiphertext: null,
    tokenNonce: null,
    tokenTag: null,
    tokenKeyId: null,
    hermesProfile: profile,
  }, config);
  const outcome = await prepareReviewProfile({
    host: client(null),
    served: client(REVIEW_PROFILE),
    withProfileNameLock: (callback) => withProfileNamesLock(db as unknown as Db, job.organization_id, [REVIEW_PROFILE], async () => callback()),
    serveWait: PROFILE_SERVE_WAIT,
  });
  const recorded = await finishReviewProfile(db, job, outcome);
  logOutcome(job, outcome, recorded, Date.now() - started);
}

function logOutcome(job: ReviewProfileJob, outcome: Awaited<ReturnType<typeof prepareReviewProfile>>, recorded: boolean, durationMs: number): void {
  // A proof that holds is not news; a change of state or a failure is.
  if (recorded && outcome.status === "proven" && job.status === "proven") return;
  logEvent(recorded ? `review_profile.${outcome.status}` : "review_profile.stale", {
    runtimeId: job.runtime_id,
    organizationId: job.organization_id,
    previous: job.status,
    failureCode: outcome.status === "failed" ? outcome.failureCode : null,
    // A transient failure over a proof that holds keeps it (`finishReviewProfile`).
    ...(outcome.status === "failed" && outcome.transient && job.status === "proven" ? { proofKept: true } : {}),
    attempt: job.attempts,
    durationMs,
  });
}
