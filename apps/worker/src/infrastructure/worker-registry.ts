import type { SQL } from "bun";
import { pgTextArray } from "@openedbot/platform-db/text-array";

export type WorkerRegistry = {
  recordHeartbeat(activeWork: number): Promise<void>;
  releaseLeasesAndClose(): Promise<void>;
};

/**
 * The permission pipelines this binary decides gates with (PERM2-1). The
 * backoffice refuses to move an organization to `v2` while a live worker
 * does not announce it.
 */
const PERMISSION_PIPELINES = ["legacy", "v2"];

export function createWorkerRegistry(db: SQL, workerId: string): WorkerRegistry {
  const startedAt = new Date();

  async function recordHeartbeat(activeWork: number): Promise<void> {
    const memory = process.memoryUsage();
    await db`
      insert into service_instances (
        id, service, process_id, rss_bytes, heap_used_bytes, active_work, started_at, heartbeat_at,
        permission_pipelines
      ) values (
        ${workerId}, 'worker', ${process.pid}, ${memory.rss}, ${memory.heapUsed},
        ${activeWork}, ${startedAt}, now(), ${pgTextArray(PERMISSION_PIPELINES)}::text[]
      )
      on conflict (id) do update set process_id = excluded.process_id, rss_bytes = excluded.rss_bytes,
        heap_used_bytes = excluded.heap_used_bytes, active_work = excluded.active_work,
        started_at = excluded.started_at, heartbeat_at = now(),
        permission_pipelines = excluded.permission_pipelines
    `;
  }

  async function releaseLeasesAndClose(): Promise<void> {
    await db`
      update runs set status = 'queued', lease_owner = null, lease_expires_at = null, updated_at = now()
       where lease_owner = ${workerId} and status in ('starting','running','awaiting_approval')
         and (external_state = 'not_started' or hermes_run_id is not null)
    `;
    await db`
      with ambiguous as (
        update runs set status = 'unknown', external_state = 'ambiguous', events_complete = false,
          error_code = 'WORKER_SHUTDOWN_DURING_CREATE',
          error_message = 'Arrêt du worker pendant une création Hermes; vérification manuelle requise.',
          lease_owner = null, lease_expires_at = null, updated_at = now()
         where lease_owner = ${workerId} and status in ('starting','running','awaiting_approval')
           and hermes_run_id is null and external_state = 'creating'
         returning organization_id, workflow_id
      )
      update workflows w set status = 'unknown', error_code = 'WORKER_SHUTDOWN_DURING_CREATE',
        error_message = 'L’effet de la création Hermes est incertain.', updated_at = now()
       from ambiguous a where w.organization_id = a.organization_id and w.id = a.workflow_id
    `;
    await db`delete from service_instances where id = ${workerId}`.catch(() => undefined);
    await db.close({ timeout: 5 });
  }

  return { recordHeartbeat, releaseLeasesAndClose };
}
