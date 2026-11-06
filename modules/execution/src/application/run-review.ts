import type { SQL } from "bun";
import { NOW, RELEASE_LEASE, transitionRuns } from "../sql/run-transitions";

/**
 * The run moves of a workflow review (`/workflows/:id/reconcile`, `abandon`,
 * `retry`), on rows the route holds locked (`lockWorkflowRuns`). None holds a
 * lease: an `unknown` run and a queued fallback have none.
 */

type Workflow = { readonly organizationId: string; readonly workflowId: string };
type Run = { readonly organizationId: string; readonly id: string };

/** `unknown` → `queued` + `polling`: the next claim reads the known Hermes run's status. */
export async function requeueForReconciliationTx(tx: SQL, run: Run): Promise<void> {
  await transitionRuns(tx, {
    target: run, fence: "unleased",
    transition: { from: ["unknown"], to: { status: "queued", externalState: "polling" } },
    set: { ...RELEASE_LEASE, nextAttemptAt: NOW, errorCode: null, errorMessage: null },
  });
}

/**
 * The workflow's `unknown` runs fail, abandoned or replaced by a retry. The
 * operator settled their uncertainty: the external state becomes `settled`
 * (defect D9: it stayed `ambiguous`, and the thread kept showing the
 * abandoned run as to review); `events_complete` keeps saying that the
 * journal may lack what Hermes did.
 */
export async function failUnknownRunsTx(
  tx: SQL,
  workflow: Workflow,
  outcome: { readonly errorCode: string; readonly errorMessage: string },
): Promise<void> {
  await transitionRuns(tx, {
    target: workflow, fence: "unleased",
    transition: { from: ["unknown"], to: { status: "failed", externalState: "settled" } },
    set: { errorCode: outcome.errorCode, errorMessage: outcome.errorMessage, ...RELEASE_LEASE, endedAt: NOW },
  });
}

/** The queued fallback of an ambiguous follow-up, abandoned with it. */
export async function failAbandonedSteerFallbackTx(tx: SQL, run: Run): Promise<void> {
  await transitionRuns(tx, {
    target: run, fence: "unleased",
    transition: { from: ["queued"], to: { status: "failed", externalState: "settled" } },
    set: {
      eventsComplete: true, errorCode: "EXTERNAL_OUTCOME_ABANDONED",
      errorMessage: "Follow-up incertain abandonné par un administrateur.", ...RELEASE_LEASE, endedAt: NOW,
    },
  });
}

/** The queued fallback of an ambiguous follow-up, released to run after a confirmed duplicate risk. */
export async function requeueSteerFallbackTx(tx: SQL, run: Run): Promise<boolean> {
  const rows = await transitionRuns(tx, {
    target: run, fence: "unleased",
    transition: { from: ["queued"], to: { status: "queued", externalState: "not_started" } },
    set: { eventsComplete: true, errorCode: null, errorMessage: null, nextAttemptAt: NOW, endedAt: null, ...RELEASE_LEASE },
  });
  return rows.length > 0;
}
