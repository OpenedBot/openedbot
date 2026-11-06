import type { SQL } from "bun";
import { HermesClientError } from "@openedbot/hermes";
import { recordDirectProbeResult } from "@openedbot/runtimes/sql/runtime-rows";
import { appendRunEventsTx } from "../sql/run-events";
import { NOW, RELEASE_LEASE, sqlExpr, transitionRuns } from "../sql/run-transitions";
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

const UNHEALTHY_DIRECT_MESSAGE = "Le runtime en accès direct n’a pas répondu à la sonde de santé à temps ; le run n’a pas démarré.";

/**
 * Same run/workflow/event settlement as the disconnected connector, without
 * replay. The update holds every failed run's row; their `run.error` is then
 * numbered by the primitive, in a statement after the cursor lock (D2).
 */
export async function failRunsOnUnhealthyDirectRuntimes(db: SQL, timeoutMs: number): Promise<number> {
  return db.begin(async (tx) => {
    const sql = tx as unknown as SQL;
    // Queued, never sent to Hermes: no lease to hold. Every run of an
    // organization with a stale runtime, as the join on the organization did.
    const failed = await transitionRuns(sql, {
      target: { sweep: true }, fence: "unleased",
      transition: { from: ["queued"], to: { status: "failed", externalState: "settled" } },
      set: {
        eventsComplete: true, errorCode: "RUNTIME_DISCONNECTED", errorMessage: UNHEALTHY_DIRECT_MESSAGE,
        endedAt: NOW, ...RELEASE_LEASE, nextAttemptAt: null,
      },
      where: sqlExpr`hermes_run_id is null and created_at < now() - (${timeoutMs} * interval '1 millisecond')
        and organization_id in (
          select rt.organization_id
            from runtimes rt
           where rt.reachability = 'direct' and rt.revoked_at is null and rt.is_active
             and (rt.last_health_status <> 'healthy' or rt.last_probed_at is null
               or rt.last_probed_at <= now() - interval '90 seconds')
        )`,
    });
    for (const run of failed) {
      if (!run.workflowId) continue;
      await sql`
        update workflows set status = 'failed',
          error_code = 'RUNTIME_DISCONNECTED',
          error_message = 'Le runtime en accès direct n’a pas répondu à la sonde de santé à temps.',
          ended_at = now(), updated_at = now()
         where organization_id = ${run.organizationId} and id = ${run.workflowId}
           and status in ('queued','running','awaiting_approval')
      `;
    }
    await appendRunEventsTx(sql, failed.map((run) => ({
      organizationId: run.organizationId, threadId: run.threadId, runId: run.id, type: "run.error", payload: { message: UNHEALTHY_DIRECT_MESSAGE, errorCode: "RUNTIME_DISCONNECTED" },
    })));
    return failed.length;
  }) as Promise<number>;
}
