import type { SQL } from "bun";
import { pgTextArray } from "@openedbot/platform-db/text-array";
import { releaseWorkerRunsOnShutdown } from "@openedbot/execution/application/worker-shutdown";

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
    await releaseWorkerRunsOnShutdown(db, workerId);
    await db`delete from service_instances where id = ${workerId}`.catch(() => undefined);
    await db.close({ timeout: 5 });
  }

  return { recordHeartbeat, releaseLeasesAndClose };
}
