import type { SQL } from "bun";
import { RunTrace, runTrace } from "@openedbot/platform-observability/run-trace";
import type { WorkerConfig } from "./worker-config";
import type { ClaimedRun } from "./queue";
import { admitClaimedRun, workflowDeadlinePassed } from "./runner/admission";
import { readContext } from "./runner/context";
import { createRunOnHermes } from "./runner/creation";
import { streamHermesEvents } from "./runner/event-stream";
import { NamedRunError, handleFailure } from "./runner/failure";
import { settleResumedRunStatus } from "./runner/lease-transitions";
import { gatherRunPreflight } from "./runner/preflight";
import { createRunState } from "./runner/run-state";
import { settleRequestedCancellation, settleRunError, settleStreamEnd } from "./runner/settlement";
import { superviseRun } from "./runner/supervision";

// Re-exports for the importers that still go through this module.
export { TRANSCRIPT_TOOLS } from "./runner/frame-events";
export { loadAssignedPlaybooks } from "./runner/instructions";
export { isRunEventsLeaseFence, persistEvents } from "./runner/persist";
export { resolveToolsetScope } from "./runner/preflight";
export { resolveRunnableSelection } from "./runner/provider-recovery";

/**
 * Runs one claimed run to its end, in named steps (ADR 0001 section 4.5,
 * S2e), each in its module under `runner/`:
 *
 * 1. préflight: `admitClaimedRun` (refusals, client), then, once a stop
 *    or a past deadline is ruled out, `gatherRunPreflight` (inventory, gate,
 *    session);
 * 2. création: `createRunOnHermes` for a new run (prompt, model, POST with
 *    its provider fallbacks, confirmation), `settleResumedRunStatus` for a
 *    resumed one;
 * 3. streaming: `streamHermesEvents`, with `enrichFrameEvents` per frame
 *    and `fallBackAfterRunFailure` (repli de fournisseur) on a failure frame;
 * 4. approbations: `forwardReadyApproval`, driven by the supervision
 *    (`superviseRun`: lease, timeouts, steers) and by the stream;
 * 5. réconciliation: `settleRequestedCancellation`, `settleStreamEnd`,
 *    `settleRunError`.
 *
 * The state the steps and the supervision share is `RunState`
 * (`runner/run-state.ts`); everything else goes in and out as arguments.
 */
export async function executeRun(
  db: SQL,
  config: WorkerConfig,
  claimed: ClaimedRun,
  shutdownSignal?: AbortSignal,
): Promise<void> {
  // Sans trace ouverte par la réclamation (appel direct), les marques tombent
  // dans une trace détachée que personne ne journalise.
  const trace = runTrace(claimed.id) ?? new RunTrace();
  const context = await trace.span("preflight.read_context", () => readContext(db, config, claimed));
  if (!context) return;
  trace.set("resumed", Boolean(context.hermesRunId));
  trace.set("reachability", context.reachability);
  trace.set("workflow", Boolean(context.workflowId));
  const client = await admitClaimedRun(db, config, context, trace);
  if (!client) return;
  const state = createRunState(context);
  const supervision = superviseRun(db, config, context, client, state, shutdownSignal);
  try {
    if (state.cancelRequested) {
      await settleRequestedCancellation(db, config, context, client, state);
      return;
    }
    if (workflowDeadlinePassed(context, Date.now())) {
      await handleFailure(db, config, context, new NamedRunError(
        "WORKFLOW_DEADLINE_EXCEEDED",
        "La durée maximale du workflow est atteinte avant cette étape.",
      ));
      return;
    }
    const preflight = await gatherRunPreflight(client, context, trace, state.controller.signal, state.hermesRunId);
    let hermesRunId = state.hermesRunId;
    if (!hermesRunId) {
      hermesRunId = await createRunOnHermes(db, config, context, client, state, trace, preflight);
      if (!hermesRunId) return;
    } else {
      await settleResumedRunStatus(db, config, context);
    }
    const streamRunId = await streamHermesEvents(
      db, config, context, client, state, trace, hermesRunId, preflight.replayProbe, supervision.forwardReadyApprovals,
    );
    if (!streamRunId) return;
    await settleStreamEnd(db, config, context, client, state, trace, streamRunId);
  } catch (error) {
    await settleRunError(db, config, context, client, state, trace, error);
  } finally {
    await supervision.stop();
  }
}
