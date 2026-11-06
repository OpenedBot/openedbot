import type { SQL } from "bun";
import { appendRunEventsTx } from "../sql/run-events";

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
    const failed = await tx<Array<{ organizationId: string; threadId: string; runId: string }>>`
      with stale_runtimes as (
        select rt.organization_id, rt.id
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
      ), failed_runs as (
        update runs run set status = 'failed', external_state = 'settled', events_complete = true,
          error_code = 'RUNTIME_DISCONNECTED',
          error_message = ${DISCONNECTED_MESSAGE},
          ended_at = now(), lease_owner = null, lease_expires_at = null,
          next_attempt_at = null, updated_at = now()
         from stale_runtimes stale
         where run.organization_id = stale.organization_id
           and run.status = 'queued' and run.hermes_run_id is null
           and run.created_at < now() - (${timeoutMs} * interval '1 millisecond')
         returning run.organization_id, run.thread_id, run.id as run_id, run.workflow_id
      ), failed_workflows as (
        update workflows workflow set status = 'failed',
          error_code = 'RUNTIME_DISCONNECTED',
          error_message = 'Le runtime n’a pas rouvert son lien connecteur à temps.',
          ended_at = now(), updated_at = now()
         from failed_runs run
         where workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
           and workflow.status in ('queued','running','awaiting_approval')
         returning workflow.organization_id, workflow.id
      )
      select organization_id as "organizationId", thread_id as "threadId", run_id as "runId" from failed_runs
    `;
    await appendRunEventsTx(tx as unknown as SQL, failed.map((run) => ({
      ...run, type: "run.error", payload: { message: DISCONNECTED_MESSAGE, errorCode: "RUNTIME_DISCONNECTED" },
    })));
    return failed.length;
  }) as Promise<number>;
}
