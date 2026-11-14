/**
 * A gate under review with nobody to review it goes to a person.
 *
 * The automatic reviewer is not part of the open core (it is the
 * `approvalReviewer` port of the plug-in `permissions`). Without it no gate
 * is born `reviewing`: the pipeline only reviews when a reviewer is ready
 * (`reviewerReady`). A gate may still be left `reviewing`: born before the
 * reviewer left this deployment, or abandoned by a reviewer that stopped.
 * Such a gate would wait forever, so this pass hands it to a person exactly
 * as an escalated review did: `awaiting_human` at stage `review`, the
 * workflow to `awaiting_approval` (which notifies). On a workflow with
 * "Never wait" (PERM2-9) nobody would answer: the gate is refused at stage
 * `unattended` instead, and nobody is notified.
 *
 * The claim takes a token and a lease, like the reviewer's, and only gates
 * at least `minAgeMs` old whose lease is free: with a reviewer installed the
 * worker passes a grace well past the review budget, so a live review is
 * never raced. A write requires the token, the gate still `pending` and
 * still `reviewing`.
 */
import type { SQL } from "bun";
import { lockWorkflowTx, permissionRuleSourceFor } from "./runner/permission-rule-sources";
import { log } from "./runner/util";

/** The claim outlives one pass: a worker that dies mid-pass is taken over, never doubled. */
const HANDOFF_LEASE_SECONDS = 25;
/** The reason the gate's trace carries, as an escalated review's code. */
export const REVIEW_HANDOFF_REASON = "review_unavailable";

type HandoffJob = {
  id: string;
  organizationId: string;
  runId: string;
  workflowId: string | null;
  claimToken: string;
};

/** Claims up to `limit` gates under review, oldest first. */
async function claimOrphanedReviewGates(db: SQL, limit: number, minAgeMs: number): Promise<HandoffJob[]> {
  return db<HandoffJob[]>`
    with candidate as (
      select a.organization_id, a.id from approval_requests a
       where a.decision_state = 'reviewing' and a.status = 'pending'
         and (a.decision_lease_expires_at is null or a.decision_lease_expires_at < now())
         and a.created_at <= now() - (${minAgeMs} * interval '1 millisecond')
       order by a.created_at
       for update skip locked
       limit ${limit}
    ), claimed as (
      update approval_requests a
         set decision_claim_token = gen_random_uuid(),
             decision_lease_expires_at = now() + (${HANDOFF_LEASE_SECONDS} * interval '1 second')
        from candidate c
       where a.organization_id = c.organization_id and a.id = c.id
      returning a.organization_id, a.id, a.run_id, a.decision_claim_token
    )
    select c.id, c.organization_id as "organizationId", c.run_id as "runId", r.workflow_id as "workflowId",
           c.decision_claim_token as "claimToken"
      from claimed c
      join runs r on r.organization_id = c.organization_id and r.id = c.run_id
  `;
}

/**
 * The run, then its workflow, then the gate: the forwarder's order
 * (runner/approval-forwarding.ts), so the two cannot deadlock. "Never wait"
 * is read through the port under the workflow lock.
 */
async function handToPerson(db: SQL, job: HandoffJob): Promise<{ written: boolean; neverWait: boolean }> {
  // Resolved outside the transaction: a slow entitlement hook never holds these locks.
  const source = await permissionRuleSourceFor(job.organizationId);
  return db.begin(async (tx) => {
    await tx`select id from runs where organization_id = ${job.organizationId} and id = ${job.runId} for update`;
    const neverWait = await lockWorkflowTx(tx as unknown as SQL, job.organizationId, job.workflowId, source);
    const rows = neverWait
      ? await tx<Array<{ id: string }>>`
          update approval_requests
             set status = 'denied', selected_choice = 'deny',
                 resolved_at = now(), resolved_by_policy = 'auto',
                 decision_state = 'decided', decided_by_kind = 'policy', decision_stage = 'unattended',
                 decision_detail = coalesce(decision_detail, '{}'::jsonb) || ${{ reason: "never_wait", heldStage: "review", heldReason: REVIEW_HANDOFF_REASON }}::jsonb,
                 decision_claim_token = null, decision_lease_expires_at = null
           where organization_id = ${job.organizationId} and id = ${job.id}
             and decision_claim_token = ${job.claimToken} and status = 'pending' and decision_state = 'reviewing'
          returning id
        `
      : await tx<Array<{ id: string }>>`
          update approval_requests
             set decision_state = 'awaiting_human', decision_stage = 'review',
                 decision_detail = coalesce(decision_detail, '{}'::jsonb) || ${{ reason: REVIEW_HANDOFF_REASON }}::jsonb,
                 decision_claim_token = null, decision_lease_expires_at = null
           where organization_id = ${job.organizationId} and id = ${job.id}
             and decision_claim_token = ${job.claimToken} and status = 'pending' and decision_state = 'reviewing'
          returning id
        `;
    if (!rows[0]) return { written: false, neverWait };
    if (!neverWait && job.workflowId) await tx`
      update workflows set status = 'awaiting_approval', updated_at = now()
       where organization_id = ${job.organizationId} and id = ${job.workflowId} and status = 'running'
    `;
    return { written: true, neverWait };
  }) as Promise<{ written: boolean; neverWait: boolean }>;
}

/**
 * One pass: hands every claimable gate under review to a person (or refuses
 * it, "Never wait"). A gate that fails is logged and left to its lease: the
 * next pass takes it again.
 */
export async function handOffReviewGates(
  db: SQL,
  options: { limit: number; minAgeMs: number; signal?: AbortSignal },
): Promise<number> {
  if (options.signal?.aborted) return 0;
  const jobs = await claimOrphanedReviewGates(db, options.limit, options.minAgeMs);
  let written = 0;
  for (const job of jobs) {
    try {
      const result = await handToPerson(db, job);
      if (result.written) written += 1;
      log("approval.decision", {
        runId: job.runId, stage: result.neverWait ? "unattended" : "review", reviewer: false,
        outcome: result.neverWait ? "deny" : "human",
        reason: result.neverWait ? "never_wait" : REVIEW_HANDOFF_REASON,
        ...(result.neverWait ? { heldReason: REVIEW_HANDOFF_REASON } : {}),
        written: result.written,
      });
    } catch (error) {
      log("approval.review_handoff_failed", { runId: job.runId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return written;
}
