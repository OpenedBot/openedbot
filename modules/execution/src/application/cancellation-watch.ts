import type { SQL } from "bun";

type AbortHandle = Pick<AbortController, "abort">;

/**
 * Interrupts in-process streams as soon as the API persists a stop request.
 *
 * The durable database flag remains the source of truth. This fast watcher
 * only removes the lease-heartbeat latency before `executeRun` sends Hermes'
 * POST /stop; the existing reconciliation path still proves the remote
 * terminal state before settling the local run.
 */
export async function interruptRequestedRuns(
  db: SQL,
  workerId: string,
  controllers: ReadonlyMap<string, AbortHandle>,
): Promise<number> {
  if (controllers.size === 0) return 0;
  const rows = await db<Array<{ id: string }>>`
    select id from runs
     where lease_owner = ${workerId}
       and status in ('starting','running','awaiting_approval')
       and remote_stop_state = 'requested'
  `;
  let interrupted = 0;
  for (const row of rows) {
    const controller = controllers.get(row.id);
    if (!controller) continue;
    controller.abort("cancel_requested");
    interrupted += 1;
  }
  return interrupted;
}
