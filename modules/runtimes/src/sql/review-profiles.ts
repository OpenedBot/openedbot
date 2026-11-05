import type { SQL } from "bun";
import { pgTextArray } from "@openedbot/platform-db/text-array";
import { REVIEW_PROFILE_FEATURES } from "../domain/runtime-contract";

/**
 * PERM2-7a (0139): the per-runtime proof that `openedbot-reviewer` runs without
 * any tool. Written by the worker only (`openedbot_worker` reads every
 * organization); the API reads its own tenant's rows.
 */
export type ReviewProfileStatus = "queued" | "proven" | "pending_restart" | "failed";

export type ReviewProfileJob = {
  runtime_id: string;
  organization_id: string;
  status: ReviewProfileStatus;
  attempts: number;
  lease_token: string;
  link_features: string[];
};

/** A proven profile is checked again this often; a proof older than the window is not trusted. */
export const REVIEW_PROFILE_RECHECK_SECONDS = 120;
export const REVIEW_PROFILE_PROOF_MAX_AGE_SECONDS = 600;
/** A restart is the owner's click: look again soon, without hammering the host. */
const REVIEW_PROFILE_PENDING_SECONDS = 30;
const REVIEW_PROFILE_RETRY_MAX_SECONDS = 900;
/** Longer than the worst preparation: creation (120 s), serve wait (45 s), the writes and the read-backs. */
const REVIEW_PROFILE_LEASE_SECONDS = 600;

/**
 * Queues a row for every active connector runtime of a `v2` organization
 * whose link announces what the review profile needs. Idempotent.
 */
export async function enqueueReviewProfiles(db: SQL): Promise<void> {
  await db`
    insert into runtime_review_profiles (runtime_id, organization_id)
    select r.id, r.organization_id
      from runtimes r join organizations o on o.id = r.organization_id
     where o.permission_pipeline = 'v2'
       and r.is_active and r.revoked_at is null
       and r.reachability = 'connector'
       and r.link_features @> ${pgTextArray(REVIEW_PROFILE_FEATURES)}::text[]
    on conflict (runtime_id) do nothing
  `;
}

/**
 * Claims one due row, `skip locked`, for a runtime that still qualifies. A
 * row whose runtime or organization no longer qualifies is left as it is:
 * `readReviewProven` only trusts it for the active runtime of a `v2`
 * organization anyway.
 */
export async function claimReviewProfile(db: SQL, workerId: string): Promise<ReviewProfileJob | null> {
  const rows = await db<ReviewProfileJob[]>`
    with candidate as (
      select p.runtime_id from runtime_review_profiles p
        join runtimes r on r.id = p.runtime_id and r.organization_id = p.organization_id
        join organizations o on o.id = p.organization_id
       where p.next_check_at <= now()
         and (p.lease_expires_at is null or p.lease_expires_at < now())
         and o.permission_pipeline = 'v2'
         and r.is_active and r.revoked_at is null and r.reachability = 'connector'
         and r.link_features @> ${pgTextArray(REVIEW_PROFILE_FEATURES)}::text[]
       order by p.next_check_at
       for update of p skip locked
       limit 1
    )
    update runtime_review_profiles p
       set attempts = p.attempts + 1, lease_owner = ${workerId}, lease_token = gen_random_uuid(),
           lease_expires_at = now() + (${REVIEW_PROFILE_LEASE_SECONDS} * interval '1 second'), updated_at = now()
      from candidate c, runtimes r
     where p.runtime_id = c.runtime_id and r.id = p.runtime_id and r.organization_id = p.organization_id
    returning p.runtime_id, p.organization_id, p.status, p.attempts, p.lease_token, r.link_features
  `;
  return rows[0] ?? null;
}

export type ReviewProfileOutcome =
  | { status: "proven" }
  | { status: "pending_restart" }
  | {
      status: "failed";
      failureCode: string;
      /**
       * The check did not reach the host (busy link, gateway restarting): it
       * proves nothing either way. A proof still fresh is kept until it ages
       * out (`REVIEW_PROFILE_PROOF_MAX_AGE_SECONDS`), so an openedbot-driven gateway
       * restart no longer turns every `auto` bot into `manual` for a pass
       * (lab, 2026-10-25). The reviewer itself hands a gate to a person when
       * the host does not answer.
       */
      transient?: true;
    };

export function reviewProfileRetrySeconds(attempts: number): number {
  return Math.min(REVIEW_PROFILE_RETRY_MAX_SECONDS, 30 * 2 ** Math.max(0, Math.min(attempts - 1, 5)));
}

/**
 * Records the outcome, guarded by the lease token: a worker whose lease was
 * taken over writes nothing. Anything but `proven` clears the proof at once,
 * except a transient failure over a proof that holds: that one keeps the
 * proof (`proven_at` unchanged, so it still ages out) and looks again soon.
 */
export async function finishReviewProfile(db: SQL, job: ReviewProfileJob, outcome: ReviewProfileOutcome): Promise<boolean> {
  const proven = outcome.status === "proven";
  const delaySeconds = proven ? REVIEW_PROFILE_RECHECK_SECONDS
    : outcome.status === "pending_restart" ? REVIEW_PROFILE_PENDING_SECONDS
    : reviewProfileRetrySeconds(job.attempts);
  const failureCode = outcome.status === "failed" ? outcome.failureCode : null;
  if (outcome.status === "failed" && outcome.transient && job.status === "proven") {
    const kept = await db<Array<{ runtime_id: string }>>`
      update runtime_review_profiles
         set checked_at = now(),
             failure_code = ${failureCode},
             next_check_at = now() + (${reviewProfileRetrySeconds(job.attempts)} * interval '1 second'),
             lease_owner = null, lease_token = null, lease_expires_at = null, updated_at = now()
       where runtime_id = ${job.runtime_id} and organization_id = ${job.organization_id}
         and lease_token = ${job.lease_token} and status = 'proven'
      returning runtime_id
    `;
    return kept.length > 0;
  }
  const rows = await db<Array<{ runtime_id: string }>>`
    update runtime_review_profiles
       set status = ${outcome.status},
           proven_at = case when ${proven} then now() else null end,
           checked_at = now(),
           failure_code = ${failureCode},
           attempts = case when ${proven} then 0 else attempts end,
           next_check_at = now() + (${delaySeconds} * interval '1 second'),
           lease_owner = null, lease_token = null, lease_expires_at = null, updated_at = now()
     where runtime_id = ${job.runtime_id} and organization_id = ${job.organization_id}
       and lease_token = ${job.lease_token}
    returning runtime_id
  `;
  return rows.length > 0;
}

/**
 * Is the review available for this organization now? Only a fresh proof for
 * its active runtime counts. Run inside the caller's transaction.
 */
export async function readReviewProven(tx: SQL, organizationId: string): Promise<boolean> {
  const rows = await tx<Array<{ proven: boolean }>>`
    select exists (
      select 1 from runtime_review_profiles p
        join runtimes r on r.id = p.runtime_id and r.organization_id = p.organization_id
       where p.organization_id = ${organizationId}
         and r.is_active and r.revoked_at is null
         and p.status = 'proven'
         and p.proven_at > now() - (${REVIEW_PROFILE_PROOF_MAX_AGE_SECONDS} * interval '1 second')
    ) as proven
  `;
  return rows[0]?.proven === true;
}
