import type { SQL } from "bun";
import { HermesClientError } from "@openedbot/hermes";
import { recordDirectProbeResult } from "@openedbot/runtimes/sql/runtime-rows";
import { createRuntimeClient, type RuntimeClientContext, type RuntimeClientConfig } from "@openedbot/execution/application/runtime-client";

export const DIRECT_PROBE_TICK_MS = 30_000;
export const DIRECT_PROBE_STALE_MS = 90_000;

type DirectProbeRow = RuntimeClientContext & { organizationId: string };

/**
 * Row locks prevent concurrent workers probing the same credentials or overwriting an
 * access change. Each network request is bounded to ten seconds by HermesClient.health.
 * The caller runs this pass separately from the claim loop, with four probes in flight.
 */
export async function probeDirectRuntimes(
  db: SQL,
  config: RuntimeClientConfig,
  probe: (row: RuntimeClientContext, config: RuntimeClientConfig) => Promise<unknown> = (row, settings) => createRuntimeClient(row, settings).health(),
  signal?: AbortSignal,
): Promise<number> {
  const dueBefore = new Date(Date.now() - DIRECT_PROBE_TICK_MS);
  const results = await Promise.all(Array.from({ length: 4 }, async () => {
    let count = 0;
    while (!signal?.aborted && await db.begin(async (tx) => {
      const rows = await tx<DirectProbeRow[]>`
        select id as "runtimeId", organization_id as "organizationId", reachability,
               endpoint as "runtimeEndpoint", token_ciphertext as "tokenCiphertext",
               token_nonce as "tokenNonce", token_tag as "tokenTag", token_key_id as "tokenKeyId",
               edge_auth_ciphertext as "edgeAuthCiphertext", edge_auth_nonce as "edgeAuthNonce",
               edge_auth_tag as "edgeAuthTag", edge_auth_key_id as "edgeAuthKeyId", null as "hermesProfile"
          from runtimes
         where reachability = 'direct' and revoked_at is null
           and (last_probed_at is null or last_probed_at <= ${dueBefore})
         order by last_probed_at asc nulls first
         limit 1 for update skip locked
      `;
      const row = rows[0];
      if (!row) return 0;
      let errorCode: string | null = null;
      try {
        const health = await probe(row, config);
        if (!health || typeof health !== "object" || Array.isArray(health)
          || (!("ok" in health && health.ok === true) && !("status" in health && ["ok", "healthy"].includes(String(health.status))))) errorCode = "RUNTIME_PROBE_INDETERMINATE";
      } catch (error) {
        // Never persist an exception message, response body, URL, or credentials.
        errorCode = error instanceof HermesClientError && error.code === "HERMES_DNS_FAILED"
          ? "RUNTIME_DNS_UNRESOLVED" : "RUNTIME_PROBE_INDETERMINATE";
      }
      await recordDirectProbeResult(tx, { runtimeId: row.runtimeId, organizationId: row.organizationId, errorCode });
      return 1;
    })) count++;
    return count;
  }));
  return results.reduce((sum, count) => sum + count, 0);
}

/** Same run/workflow/event settlement as the disconnected connector, without replay. */
export async function failRunsOnUnhealthyDirectRuntimes(db: SQL, timeoutMs: number): Promise<number> {
  const rows = await db<Array<{ count: string | number }>>`
    with stale_runtimes as (
      select rt.organization_id, rt.id
        from runtimes rt
       where rt.reachability = 'direct' and rt.revoked_at is null and rt.is_active
         and (rt.last_health_status <> 'healthy' or rt.last_probed_at is null
           or rt.last_probed_at <= now() - interval '90 seconds')
    ), failed_runs as (
      update runs run set status = 'failed', external_state = 'settled', events_complete = true,
        error_code = 'RUNTIME_DISCONNECTED',
        error_message = 'Le runtime en accès direct n’a pas répondu à la sonde de santé à temps ; le run n’a pas démarré.',
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
        error_message = 'Le runtime en accès direct n’a pas répondu à la sonde de santé à temps.',
        ended_at = now(), updated_at = now()
       from failed_runs run
       where workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
         and workflow.status in ('queued','running','awaiting_approval')
       returning workflow.organization_id, workflow.id
    ), cursor_locks as materialized (
      select organization_id,
             pg_advisory_xact_lock(hashtext(organization_id::text), hashtext('openedbot-run-events-cursor')) as locked
        from (select distinct organization_id from failed_runs) organizations
       order by organization_id
    ), event_rows as (
      select run.organization_id, run.thread_id, run.run_id,
             coalesce((select max(event.sequence) + 1 from run_events event
                        where event.organization_id = run.organization_id and event.run_id = run.run_id), 0) as sequence
        from failed_runs run
        join cursor_locks cursor on cursor.organization_id = run.organization_id
    ), inserted as (
      insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at)
      select organization_id, thread_id, run_id, sequence, 'run.error',
             jsonb_build_object(
               'message', 'Le runtime en accès direct n’a pas répondu à la sonde de santé à temps ; le run n’a pas démarré.',
               'errorCode', 'RUNTIME_DISCONNECTED'
             ), now()
        from event_rows
      on conflict (organization_id, run_id, sequence) do nothing
      returning run_id
    )
    select count(*) as count from failed_runs
  `;
  return Number(rows[0]?.count ?? 0);
}
