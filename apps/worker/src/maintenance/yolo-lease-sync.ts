import type { SQL } from "bun";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { yoloLeaseFrameOf, type YoloHostFrame } from "@openedbot/runtime-link/application/link-yolo";
import { LINK_CONTROL_CALL_TIMEOUT_MS, type LinkControlOptions, type LinkFetch } from "@openedbot/runtime-link/application/runtime-links";

/**
 * Mode YOLO (PR 4/8) : ce que la poussée au mieux de l'API a laissé en route.
 * Calque de `approval-policy-reconciliation.ts` : des lots bornés, un curseur
 * d'organisation, un recul par bail.
 *
 *   - un bail échu sans nouvelle de l'hôte est marqué `expired` (raison
 *     `window_elapsed`) : l'écran ne le montre plus en attente ;
 *   - un bail vivant jamais livré est repoussé (`yolo.lease`) ;
 *   - un bail révoqué ici que l'hôte dit encore actif reçoit de nouveau sa
 *     révocation (`yolo.revoke`).
 *
 * Seuls les runtimes connectés qui annoncent `yolo_lease` (et
 * `yolo_thread_scope` pour un bail de thread) sont visés. La reconnexion,
 * elle, se réconcilie sur le lien : l'hôte envoie `yolo.state` après sa
 * preuve de possession, et `link-yolo.ts` lui redonne ce qui lui manque.
 *
 * Les baux sont sous la politique tenant d'`ohb_worker` (0158) : chaque
 * organisation est lue sous `withTenant`, jamais en `using (true)`.
 */
const ORGANIZATION_BATCH = 50;
const LEASE_BATCH = 50;
/** L'API pousse elle-même à l'octroi : le worker n'y revient qu'après ce délai. */
const FIRST_RETRY_AFTER_SECONDS = 30;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;

let cursor: string | null = null;
const retries = new Map<string, { failures: number; nextAttemptAt: number }>();

export type YoloLeaseSyncPass = { expired: number; pushed: number; failed: number };

type DueLease = {
  id: string;
  runtimeId: string;
  payload: unknown;
  keyId: string;
  signature: string;
  revokedAt: Date | null;
};

function recordFailure(leaseId: string, nowMs: number): void {
  const failures = (retries.get(leaseId)?.failures ?? 0) + 1;
  retries.set(leaseId, { failures, nextAttemptAt: nowMs + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 5)) });
}

/** La trame d'un bail dû : sa révocation s'il est révoqué, sinon le bail signé tel qu'enregistré. */
export function yoloSyncFrame(lease: DueLease): YoloHostFrame | null {
  if (lease.revokedAt) return { t: "yolo.revoke", leaseId: lease.id, revokedAt: Math.floor(new Date(lease.revokedAt).getTime() / 1000) };
  return yoloLeaseFrameOf(lease);
}

/** Le relais de contrôle de l'instance qui tient le lien, comme `link.rotate` ; `true` : écrit sur le lien. */
async function pushControl(options: LinkControlOptions, fetchImpl: LinkFetch, runtimeId: string, frame: YoloHostFrame): Promise<boolean> {
  const origin = (options.runtimeLinkInternalUrl ?? options.apiInternalUrl).replace(/\/+$/, "");
  try {
    const response = await fetchImpl(`${origin}/internal/runtime-links/${encodeURIComponent(runtimeId)}/control`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiInternalToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "yolo", frame }),
      cache: "no-store",
      signal: AbortSignal.timeout(LINK_CONTROL_CALL_TIMEOUT_MS),
    });
    const body = response.ok ? await response.json().catch(() => ({})) as { pushed?: unknown } : {};
    return body.pushed === true;
  } catch {
    return false;
  }
}

export async function syncYoloLeases(
  db: SQL,
  options: LinkControlOptions & { firstRetryAfterSeconds?: number },
  signal?: AbortSignal,
): Promise<YoloLeaseSyncPass> {
  const fetchImpl: LinkFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const firstRetryAfter = options.firstRetryAfterSeconds ?? FIRST_RETRY_AFTER_SECONDS;
  const now = () => (options.now?.() ?? new Date()).getTime();
  const pass: YoloLeaseSyncPass = { expired: 0, pushed: 0, failed: 0 };
  const organizations = await db<Array<{ organizationId: string }>>`
    select distinct organization_id::text as "organizationId" from runtimes
     where reachability = 'connector' and revoked_at is null
       and link_features @> array['yolo_lease']::text[]
       and (${cursor ?? ""} = '' or organization_id::text > ${cursor ?? ""})
     order by 1
     limit ${ORGANIZATION_BATCH}
  `;
  if (organizations.length === 0) {
    cursor = null;
    return pass;
  }
  for (const { organizationId } of organizations) {
    if (signal?.aborted) return pass;
    cursor = organizationId;
    const due = await withTenant(db as unknown as Db, organizationId, async (tx) => {
      const expired = await tx`
        update permission_yolo_leases
           set host_state = 'expired', host_state_reason = 'window_elapsed', host_state_at = now()
         where organization_id = ${organizationId} and revoked_at is null and expires_at <= now()
           and host_state in ('pending', 'active')
        returning id
      `;
      pass.expired += expired.length;
      return tx<DueLease[]>`
        select l.id, l.runtime_id as "runtimeId", l.payload, l.key_id as "keyId", l.signature, l.revoked_at as "revokedAt"
          from permission_yolo_leases l
          join runtimes r on r.organization_id = l.organization_id and r.id = l.runtime_id
         where l.organization_id = ${organizationId}
           and r.reachability = 'connector' and r.revoked_at is null
           and r.link_connected_at is not null and r.last_health_status <> 'disconnected'
           and r.link_features @> array['yolo_lease']::text[]
           and (l.scope <> 'thread' or r.link_features @> array['yolo_thread_scope']::text[])
           and l.expires_at > now()
           and ((l.revoked_at is null and l.delivered_at is null and l.created_at <= now() - make_interval(secs => ${firstRetryAfter}))
             or (l.revoked_at is not null and l.delivered_at is not null and l.host_state in ('pending', 'active')))
         order by l.created_at, l.id
         limit ${LEASE_BATCH}
      `;
    });
    for (const lease of due) {
      if (signal?.aborted) return pass;
      if ((retries.get(lease.id)?.nextAttemptAt ?? 0) > now()) continue;
      const frame = yoloSyncFrame(lease);
      if (!frame) {
        recordFailure(lease.id, now());
        console.error(JSON.stringify({ event: "worker.yolo_lease_unreadable", organizationId, runtimeId: lease.runtimeId, leaseId: lease.id }));
        continue;
      }
      if (await pushControl(options, fetchImpl, lease.runtimeId, frame)) {
        retries.delete(lease.id);
        pass.pushed += 1;
      } else {
        recordFailure(lease.id, now());
        pass.failed += 1;
      }
    }
  }
  // Un bail sorti des lots dus n'a plus de recul à tenir.
  if (retries.size > 10_000) retries.clear();
  return pass;
}

/** Tests only: a fresh pass starts from the first organization and forgets every backoff. */
export function resetYoloLeaseSync(): void {
  cursor = null;
  retries.clear();
}
