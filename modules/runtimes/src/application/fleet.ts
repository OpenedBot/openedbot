import { metricsPeriod, readBusinessMetrics } from "./business-metrics";
import { logger } from "@openedbot/platform-observability";
import type { AccountWorkspace, AgencyClientDto, FleetClient, FleetRuntime } from "@openedbot/contracts-api";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { HttpError } from "@openedbot/contracts-errors/http-error";

export async function assertClientMandate(tx: TransactionDb, userId: string, clientId: string, agencyId: string): Promise<void> {
  const access = await tx<Array<{ viaAgencyIds: string[] }>>`select via_agency_ids as "viaAgencyIds"
    from workspace_access(${userId}::uuid, ${clientId}::uuid)`;
  if (!access[0]?.viaAgencyIds.includes(agencyId)) {
    throw new HttpError(403, "WORKSPACE_ACCESS_REVOKED", "Vous n’avez plus accès à ce client.");
  }
}

/** Reads observations only. Opening a fleet must never contact customer hosts. */
export async function readFleetClient(db: Db, userId: string, agencyId: string, workspace: AccountWorkspace, detail = false, period = metricsPeriod()): Promise<AgencyClientDto> {
  return withTenant(db, workspace.id, async (tx) => {
    // Revalidate this agency's mandate even when a direct membership takes role precedence.
    await assertClientMandate(tx, userId, workspace.id, agencyId);
    const runtimes = await tx<FleetRuntime[]>`select id, name, reachability,
      coalesce(last_health_status, 'unknown') as health,
      link_last_seen_at::text as "lastSeenAt", last_probed_at::text as "lastProbedAt", last_health_error as error
      from runtimes where organization_id = ${workspace.id} and is_active and revoked_at is null`;
    const runtime = runtimes[0] ?? null;
    const providerIncidents = runtime ? await tx<Array<{ provider: string; kind: string }>>`
      select provider, kind from runtime_provider_incidents where organization_id = ${workspace.id}
        and runtime_id = ${runtime.id} and until > now() order by provider limit 50` : [];
    const accessEvents = detail ? await tx<AgencyClientDto["accessEvents"]>`select id, kind, role,
      actor_user_id as "actorUserId", occurred_at::text as "occurredAt" from membership_events
      where organization_id = ${workspace.id} and subject_organization_id = ${agencyId}
        and kind in ('agency_granted', 'agency_revoked') order by occurred_at desc, id desc limit 50` : [];
    const verifications = detail && runtime ? await tx<AgencyClientDto["verifications"]>`select id, verdict, received_at::text as "occurredAt"
      from runtime_audit_verifications where organization_id = ${workspace.id} and runtime_id = ${runtime.id}
      order by received_at desc, id desc limit 20` : [];
    const events = detail && runtime ? await tx<AgencyClientDto["events"]>`select id, kind, occurred_at::text as "occurredAt"
      from runtime_link_events where organization_id = ${workspace.id} and runtime_id = ${runtime.id}
      order by occurred_at desc, id desc limit 50` : [];
    const diagnostics = detail && runtime ? await tx<AgencyClientDto["diagnostics"]>`select id, code, component, occurred_at::text as "occurredAt"
      from runtime_link_diagnostics where organization_id = ${workspace.id} and runtime_id = ${runtime.id}
      order by received_at desc, id desc limit 50` : [];
    const metrics = await readBusinessMetrics(tx, workspace.id, period);
    // A revocation committed while observations were read must close this exact
    // agency frame, even if another agency or direct membership remains valid.
    await assertClientMandate(tx, userId, workspace.id, agencyId);
    const observedAt = new Date().toISOString();
    return { metrics, period, workspace, runtime, observedAt,
      mandate: { agencyOrganizationId: agencyId, clientOrganizationId: workspace.id, state: "active", verifiedAt: observedAt },
      agentCount: metrics.activeBots + metrics.archivedBots, error: false, providerIncidents, accessEvents, verifications, events, diagnostics };
  });
}

export async function readFleetPage(db: Db, userId: string, agencyId: string, workspaces: AccountWorkspace[], period = metricsPeriod(), requestId = crypto.randomUUID()): Promise<FleetClient[]> {
  const clients: FleetClient[] = [];
  for (let offset = 0; offset < workspaces.length; offset += 4) {
    const group = workspaces.slice(offset, offset + 4);
    const durations: number[] = [];
    const results = await Promise.allSettled(group.map(async (workspace, index) => {
      const started = performance.now();
      try { return await readFleetClient(db, userId, agencyId, workspace, false, period); }
      finally { durations[index] = Math.round(performance.now() - started); }
    }));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") clients.push(result.value);
      else if (!(result.reason instanceof HttpError && result.reason.code === "WORKSPACE_ACCESS_REVOKED")) {
        logger.warn({ requestId, agencyId, clientId: group[index]!.id, code: "CLIENT_READ_FAILED", durationMs: durations[index] }, "agency.client.read");
        clients.push({ workspace: group[index]!, runtime: null, agentCount: 0, error: true, metrics: null, period, errorCode: "CLIENT_READ_FAILED" });
      }
    });
  }
  return clients;
}
