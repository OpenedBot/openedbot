import type { SQL } from "bun";
import { ACTIVE_RUN_STATUSES } from "../domain/run-transitions";
import { leaseFence, RELEASE_LEASE, sqlExpr, transitionRuns } from "../sql/run-transitions";

/**
 * A stopping worker hands back the runs it still holds, each under its own
 * lease (a lease that already lapsed is the sweep's). The same outcome as the
 * sweep of an expired lease (`queue-sweeps.ts`), immediately:
 *
 * - never sent to Hermes (`not_started`), or with a known Hermes id: back to
 *   the queue. With an id, `polling` and `events_complete = false`, so that
 *   the next claim reconciles by reading the run's status when the host does
 *   not announce a replay (defect D4: the external state used to stay
 *   `streaming`, and the resume reattached to the live stream instead);
 * - a create sent without an id coming back: `unknown`, never retried.
 */
export async function releaseWorkerRunsOnShutdown(db: SQL, workerId: string): Promise<void> {
  await db.begin(async (tx) => {
    const sql = tx as unknown as SQL;
    const held = await sql<Array<{ organizationId: string; id: string; leaseGeneration: number | string }>>`
      select organization_id as "organizationId", id, lease_generation as "leaseGeneration" from runs
       where lease_owner = ${workerId} and status in ('starting','running','awaiting_approval')
       order by organization_id, id for update
    `;
    for (const run of held) {
      const target = { organizationId: run.organizationId, id: run.id };
      const fence = leaseFence(workerId, Number(run.leaseGeneration));
      const requeued = await transitionRuns(sql, {
        target, fence,
        transition: { from: ACTIVE_RUN_STATUSES, to: { status: "queued", externalState: { withHermesRun: "polling", withoutHermesRun: "not_started" } } },
        set: { ...RELEASE_LEASE, eventsComplete: sqlExpr`case when hermes_run_id is null then events_complete else false end` },
        where: sqlExpr`external_state = 'not_started' or hermes_run_id is not null`,
      });
      if (requeued.length > 0) continue;
      const [ambiguous] = await transitionRuns(sql, {
        target, fence,
        transition: { from: ACTIVE_RUN_STATUSES, fromExternalState: ["creating"], to: { status: "unknown", externalState: "ambiguous" } },
        set: {
          eventsComplete: false, errorCode: "WORKER_SHUTDOWN_DURING_CREATE",
          errorMessage: "Arrêt du worker pendant une création Hermes; vérification manuelle requise.", ...RELEASE_LEASE,
        },
        where: sqlExpr`hermes_run_id is null`,
      });
      if (ambiguous?.workflowId) {
        await sql`
          update workflows set status = 'unknown', error_code = 'WORKER_SHUTDOWN_DURING_CREATE',
            error_message = 'L’effet de la création Hermes est incertain.', updated_at = now()
           where organization_id = ${ambiguous.organizationId} and id = ${ambiguous.workflowId}
        `;
      }
    }
  });
}
