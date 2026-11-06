import type { SQL } from "bun";
import { appendRunEventsTx } from "../sql/run-events";
import { NOW, RELEASE_LEASE, sqlExpr, transitionRuns } from "../sql/run-transitions";

const DISCONNECTED_MESSAGE = "Le runtime n’a pas rouvert son lien connecteur à temps ; le run n’a pas démarré.";

/**
 * Un run `queued` sans run Hermes, dont le runtime `connector` actif est
 * `disconnected` depuis plus longtemps que `timeoutMs`, échoue
 * `RUNTIME_DISCONNECTED` : avec son événement `run.error`, sinon le fil reste
 * muet (le client ne lit que `run_events`). Même forme que la panne d'un
 * runtime direct (`runtime-direct.ts`) : la mise à jour tient la ligne de
 * chaque run échoué, puis la primitive numérote son `run.error` après le
 * verrou du curseur, dans une instruction distincte (D2, S2c). Vit ici, avec
 * les tables qu'il écrit : `runtime-link` ne peut pas importer `execution`.
 */
export async function failRunsOnDisconnectedRuntimes(db: SQL, timeoutMs: number): Promise<number> {
  return db.begin(async (tx) => {
    const sql = tx as unknown as SQL;
    // Queued, never sent to Hermes: no lease to hold. Every run of an
    // organization with a stale runtime, as the join on the organization did.
    const failed = await transitionRuns(sql, {
      target: { sweep: true }, fence: "unleased",
      transition: { from: ["queued"], to: { status: "failed", externalState: "settled" } },
      set: {
        eventsComplete: true, errorCode: "RUNTIME_DISCONNECTED", errorMessage: DISCONNECTED_MESSAGE,
        endedAt: NOW, ...RELEASE_LEASE, nextAttemptAt: null,
      },
      where: sqlExpr`hermes_run_id is null and created_at < now() - (${timeoutMs} * interval '1 millisecond')
        and organization_id in (
          select rt.organization_id
            from runtimes rt
            left join api_instances inst on inst.instance_id = rt.link_instance_id
           where rt.reachability = 'connector'
             and rt.revoked_at is null
             and rt.is_active
             and rt.last_health_status = 'disconnected'
             and (
               coalesce(rt.link_last_seen_at, rt.updated_at) < now() - (${timeoutMs} * interval '1 millisecond')
               or inst.instance_id is null
               or inst.stopped_at is not null
               or inst.last_seen_at < now() - interval '60 seconds'
             )
             and not (
               inst.instance_id is not null
               and inst.stopped_at is null
               and inst.last_seen_at > now() - interval '60 seconds'
               and rt.link_last_seen_at is not null
               and rt.link_last_seen_at > now() - interval '45 seconds'
             )
        )`,
    });
    for (const run of failed) {
      if (!run.workflowId) continue;
      await sql`
        update workflows set status = 'failed',
          error_code = 'RUNTIME_DISCONNECTED',
          error_message = 'Le runtime n’a pas rouvert son lien connecteur à temps.',
          ended_at = now(), updated_at = now()
         where organization_id = ${run.organizationId} and id = ${run.workflowId}
           and status in ('queued','running','awaiting_approval')
      `;
    }
    await appendRunEventsTx(sql, failed.map((run) => ({
      organizationId: run.organizationId, threadId: run.threadId, runId: run.id, type: "run.error", payload: { message: DISCONNECTED_MESSAGE, errorCode: "RUNTIME_DISCONNECTED" },
    })));
    return failed.length;
  }) as Promise<number>;
}
