import type { Db } from "@openedbot/platform-db";

export type ClaimedIngress = {
  id: string;
  organizationId: string;
  state: "abandoned" | "completed";
  previousState: "reserved" | "abandoned" | "completed";
  reservationEpoch: string | number;
  attachmentManifest: unknown;
};

/** A claimed `message_ingress` row, with the lease that proves this worker still owns it. */
export type ClaimedTask = ClaimedIngress & {
  owner: string;
  epoch: number;
};

export type ObjectSafety = {
  owned: boolean;
  attached: boolean;
  protectedByIngress: boolean;
};

export async function claimIngress(
  db: Db,
  workerId: string,
  leaseSeconds: number,
  abandonGraceSeconds: number,
): Promise<ClaimedTask | null> {
  const owner = `ingress-cleanup:${workerId}:${crypto.randomUUID()}`;
  const rows = await db<ClaimedIngress[]>`
    with candidate as (
      select id, state as previous_state from message_ingress
       where (
         state = 'reserved'
         and (reservation_lease_expires_at is null or reservation_lease_expires_at <= now())
       ) or (
         state in ('completed', 'abandoned') and expires_at <= now()
         and (reservation_lease_expires_at is null or reservation_lease_expires_at <= now())
       )
       order by case when state = 'reserved'
                  then coalesce(reservation_lease_expires_at, updated_at)
                  else expires_at
                end asc,
                created_at asc
       for update skip locked
       limit 1
    )
    update message_ingress ingress
       set state = case when ingress.state = 'reserved' then 'abandoned' else ingress.state end,
           reservation_owner = ${owner},
           reservation_epoch = ingress.reservation_epoch + 1,
           reservation_lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
           expires_at = case when ingress.state = 'reserved'
             then now() + (${abandonGraceSeconds} * interval '1 second')
             else ingress.expires_at end,
           updated_at = now()
      from candidate
     where ingress.id = candidate.id
     returning ingress.id, ingress.organization_id as "organizationId", ingress.state,
               candidate.previous_state as "previousState",
               ingress.reservation_epoch as "reservationEpoch",
               ingress.attachment_manifest as "attachmentManifest"
  `;
  const row = rows[0];
  if (!row) return null;
  const epoch = Number(row.reservationEpoch);
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("Invalid ingress reservation epoch.");
  return { ...row, owner, epoch };
}

export async function releaseQuarantinedIngress(db: Db, task: ClaimedTask): Promise<boolean> {
  const rows = await db<Array<{ id: string }>>`
    update message_ingress
       set reservation_owner = null, reservation_lease_expires_at = null, updated_at = now()
     where id = ${task.id} and state = 'abandoned'
       and reservation_owner = ${task.owner} and reservation_epoch = ${task.epoch}
       and reservation_lease_expires_at > now() and expires_at > now()
     returning id
  `;
  return Boolean(rows[0]);
}

/** Vrai quand le bail était encore tenu et a été prolongé. */
export async function renewIngressLease(db: Db, task: ClaimedTask, leaseSeconds: number): Promise<boolean> {
  const rows = await db<Array<{ id: string }>>`
    update message_ingress
       set reservation_lease_expires_at = now() + (${leaseSeconds} * interval '1 second'), updated_at = now()
     where id = ${task.id} and state = ${task.state}
       and reservation_owner = ${task.owner} and reservation_epoch = ${task.epoch}
       and reservation_lease_expires_at > now()
     returning id
  `;
  return Boolean(rows[0]);
}

export async function readObjectSafety(db: Db, task: ClaimedTask, key: string): Promise<ObjectSafety> {
  const rows = await db<ObjectSafety[]>`
    select
      exists(
        select 1 from message_ingress own
         where own.id = ${task.id} and own.state = 'abandoned'
           and own.reservation_owner = ${task.owner} and own.reservation_epoch = ${task.epoch}
           and own.reservation_lease_expires_at > now()
      ) as owned,
      exists(select 1 from attachments a where a.object_key = ${key}) as attached,
      exists(
        select 1 from message_ingress other
         where other.organization_id = ${task.organizationId}
           and other.id <> ${task.id} and other.state in ('reserved', 'completed')
           and exists (
             select 1 from jsonb_array_elements(other.attachment_manifest) item
              where item->>'key' = ${key}
           )
      ) as "protectedByIngress"
  `;
  return rows[0] ?? { owned: false, attached: false, protectedByIngress: false };
}

export async function purgeClaimedIngress(db: Db, task: ClaimedTask): Promise<boolean> {
  const rows = await db<Array<{ id: string }>>`
    delete from message_ingress
     where id = ${task.id} and state = ${task.state}
       and reservation_owner = ${task.owner} and reservation_epoch = ${task.epoch}
       and reservation_lease_expires_at > now() and expires_at <= now()
     returning id
  `;
  return Boolean(rows[0]);
}

export async function deferIngressRetry(db: Db, task: ClaimedTask, retrySeconds: number): Promise<void> {
  await db`
    update message_ingress
       set reservation_owner = null,
           reservation_lease_expires_at = now() + (${retrySeconds} * interval '1 second'),
           updated_at = now()
     where id = ${task.id} and state = ${task.state}
       and reservation_owner = ${task.owner} and reservation_epoch = ${task.epoch}
  `;
}
