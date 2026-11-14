/**
 * Rework-flux-api step 5d: is the link of a runtime effectively alive, and
 * until when does that hold without news?
 *
 * `runtimes.link_connected_at` alone says a WebSocket was opened, not that it
 * still is: an API killed without a clean stop leaves it set. Alive: a sign
 * of life within `LINK_SILENT_SECONDS`, and an owner instance that beat
 * within `INSTANCE_DEAD_SECONDS` and was not replaced at its address by a
 * newer live one (the predicate of the worker's passes).
 */
export const LINK_SILENT_SECONDS = 45;
export const INSTANCE_DEAD_SECONDS = 60;
/**
 * The worker's sweep marks a silent link disconnected (and 0178 pushes it)
 * within about a second of the 45 s; past this grace, a client that heard
 * nothing must reread rather than trust its copy.
 */
export const LINK_VERDICT_GRACE_SECONDS = 30;

export type LinkVitality = { live: boolean; validUntil: Date | null };

/**
 * A relation `(organization_id uuid)`: the organizations whose active runtime
 * is a connector the run queue would not serve now. The queue claims for a
 * connector only on a sign of life within `LINK_SILENT_SECONDS`
 * (`execution/application/queue.ts`); a link never seen, silent past that,
 * or closed (`disconnected`, by a clean close or the worker's sweep) is held
 * here too. `markLinkConnected` and `markLinkSeen` both write a fresh sign of
 * life and lift `disconnected`, which brings the organization back. At most
 * one row per organization (`runtimes_one_active_per_org`), and every bot and
 * room of an organization runs on that runtime. A SQL fragment for a
 * set-based query to `left join`, built from the caller's `tx`: never `await`
 * it alone. A direct runtime, or an organization without an active runtime,
 * never appears here.
 */
export function disconnectedHostOrganizations(tx: Bun.SQL | Bun.TransactionSQL): Bun.SQL.Query<unknown> {
  return tx`(
    select rt.organization_id
      from runtimes rt
     where rt.is_active and rt.revoked_at is null
       and rt.reachability = 'connector'
       and (rt.link_last_seen_at is null
         or rt.link_last_seen_at <= now() - (${LINK_SILENT_SECONDS} * interval '1 second')
         or rt.last_health_status = 'disconnected')
  )`;
}

export async function readLinkVitality(tx: Bun.TransactionSQL, organizationId: string, runtimeId: string): Promise<LinkVitality> {
  const rows = await tx<Array<{ live: boolean; valid_until: Date | null }>>`
    with link as (
      select r.link_connected_at is not null
             and r.link_last_seen_at > now() - (${LINK_SILENT_SECONDS} * interval '1 second')
             and inst.instance_id is not null
             and inst.stopped_at is null
             and inst.last_seen_at > now() - (${INSTANCE_DEAD_SECONDS} * interval '1 second')
             and not exists (
               select 1 from api_instances newer
                where newer.internal_url = inst.internal_url
                  and newer.started_at > inst.started_at
                  and newer.stopped_at is null
                  and newer.last_seen_at > now() - (${INSTANCE_DEAD_SECONDS} * interval '1 second')
             ) as live,
             least(r.link_last_seen_at + (${LINK_SILENT_SECONDS} * interval '1 second'),
                   inst.last_seen_at + (${INSTANCE_DEAD_SECONDS} * interval '1 second'))
               + (${LINK_VERDICT_GRACE_SECONDS} * interval '1 second') as horizon
        from runtimes r
        left join api_instances inst on inst.instance_id = r.link_instance_id
       where r.id = ${runtimeId} and r.organization_id = ${organizationId}
    )
    select live, case when live then horizon end as valid_until from link
  `;
  const row = rows[0];
  return { live: row?.live === true, validUntil: row?.valid_until ?? null };
}
