import type { SQL, TransactionSQL } from "bun";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { RuntimeProfileDeleteJobItemDto } from "@openedbot/contracts-api";
import { HermesClientError, type HermesClient } from "@openedbot/hermes";
import { ProfileDeleteError, ProfileImportError } from "@openedbot/roster/domain/profile-errors";
import { lockProfileImports } from "@openedbot/roster/application/profile-reservations";
import { DELETE_LEASE_SECONDS, type DeleteJobRow } from "../sql/delete-jobs";
import { deleteHostProfile, type HostProfileDeleteClient, type HostProfileDeleteOwnership } from "./host-profile-delete";

export type DeleteExecutorDependencies = {
  client(runtimeId: string, profile?: string): HostProfileDeleteClient & Pick<HermesClient, "deleteSession">;
  signal?: AbortSignal;
};

export class DeleteLeaseLost extends Error {}

export async function claimProfileDelete(db: SQL, workerId: string): Promise<DeleteJobRow | null> {
  const rows = await db<DeleteJobRow[]>`
    with candidate as (
      select id from profile_delete_jobs where status in ('queued','running')
        and (lease_expires_at is null or lease_expires_at <= now())
      order by created_at asc, id asc for update skip locked limit 1
    )
    update profile_delete_jobs j set status = 'running', lease_owner = ${workerId},
      lease_generation = j.lease_generation + 1,
      lease_expires_at = now() + (${DELETE_LEASE_SECONDS} * interval '1 second'), updated_at = now()
    from candidate where j.id = candidate.id returning j.*
  `;
  return rows[0] ?? null;
}

export async function executeProfileDelete(db: SQL, claimed: DeleteJobRow, deps: DeleteExecutorDependencies): Promise<void> {
  let lost = false;
  let renewing = false;
  let deadline = Math.min(Date.now() + DELETE_LEASE_SECONDS * 1000, new Date(claimed.lease_expires_at!).getTime());
  let monotonicDeadline = performance.now() + Math.max(0, deadline - Date.now());
  const checkLocal = () => {
    if (lost || Date.now() >= deadline || performance.now() >= monotonicDeadline || deps.signal?.aborted) {
      throw new DeleteLeaseLost();
    }
  };
  // Le bail relu sous verrou dans la transaction de l'appelant, qui a déjà
  // pris le verrou d'import (même ordre partout : import, puis job).
  const fenceTx = async (tx: TransactionSQL): Promise<DeleteJobRow> => {
    checkLocal();
    const rows = await tx<DeleteJobRow[]>`
      select * from profile_delete_jobs where id = ${claimed.id} and organization_id = ${claimed.organization_id}
        and status = 'running' and lease_owner = ${claimed.lease_owner} and lease_generation = ${claimed.lease_generation}
        and lease_expires_at > now() for update
    `;
    if (!rows[0]) { lost = true; throw new DeleteLeaseLost(); }
    checkLocal();
    return rows[0];
  };
  const guarded = async <T>(fn: (tx: TransactionSQL, job: DeleteJobRow) => Promise<T>): Promise<T> => {
    checkLocal();
    return db.begin(async (tx) => {
      await lockProfileImports(tx, claimed.organization_id);
      return fn(tx, await fenceTx(tx));
    }) as Promise<T>;
  };
  // Rejoué par `deleteHostProfile` avant chaque mutation, distante ou SQL.
  const ownership: HostProfileDeleteOwnership = {
    assertOwned: () => guarded(async () => undefined),
    assertOwnedTx: async (tx) => { await fenceTx(tx); },
  };
  const heartbeat = setInterval(() => {
    if (renewing || lost || deps.signal?.aborted) return;
    renewing = true;
    const renewalStarted = Date.now();
    const renewalMonotonic = performance.now();
    void db<Array<{ id: string }>>`
      update profile_delete_jobs set lease_expires_at = now() + (${DELETE_LEASE_SECONDS} * interval '1 second')
      where id = ${claimed.id} and status = 'running' and lease_owner = ${claimed.lease_owner}
        and lease_generation = ${claimed.lease_generation} and lease_expires_at > now() returning id
    `.then((rows) => {
      if (!rows.length) lost = true;
      else {
        deadline = renewalStarted + DELETE_LEASE_SECONDS * 1000;
        monotonicDeadline = renewalMonotonic + DELETE_LEASE_SECONDS * 1000;
      }
    }).catch(() => { lost = true; }).finally(() => { renewing = false; });
  }, 10_000);

  try {
    const host = deps.client(claimed.runtime_id);
    const done = new Set((claimed.results ?? []).map((item) => item.slug));
    for (const slug of claimed.slugs) {
      if (done.has(slug)) continue;
      checkLocal();
      await guarded(async (tx) => {
        await tx`
          update profile_delete_jobs set current_slug = ${slug}, updated_at = now()
           where id = ${claimed.id}
        `;
      });
      let item: RuntimeProfileDeleteJobItemDto;
      try {
        await deleteHostProfile(db, claimed.organization_id, slug, {
          host,
          sessionClient: (profile) => deps.client(claimed.runtime_id, profile),
          ownership,
        });
        item = { slug, ok: true };
      } catch (error) {
        if (error instanceof DeleteLeaseLost) throw error;
        const publicError = publicDeleteFailure(error);
        item = { slug, ok: false, error: publicError };
      }
      await guarded(async (tx, job) => {
        const results = [...(Array.isArray(job.results) ? job.results : []), item];
        await tx`
          update profile_delete_jobs
             set results = ${JSON.stringify(results)}::text::jsonb,
                 completed_profiles = ${results.length},
                 current_slug = null,
                 updated_at = now()
           where id = ${claimed.id}
        `;
      });
      done.add(slug);
    }
    await guarded(async (tx, job) => {
      const results = Array.isArray(job.results) ? job.results : [];
      const failed = results.filter((item) => !item.ok);
      const status = failed.length === 0 ? "succeeded" : "failed";
      const error = failed[0]
        ? { code: failed[0].error?.code ?? "PROFILE_DELETE_FAILED", message: failed[0].error?.message ?? "La suppression d’un profil a échoué." }
        : null;
      await tx`
        update profile_delete_jobs
           set status = ${status}, finished_at = now(), updated_at = now(),
               current_slug = null, lease_owner = null, lease_expires_at = null,
               error = ${error ? JSON.stringify(error) : null}::text::jsonb
         where id = ${claimed.id}
      `;
    });
  } catch (error) {
    if (error instanceof DeleteLeaseLost) return;
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function purgeOldProfileDeletes(db: SQL): Promise<void> {
  await db`delete from profile_delete_jobs where status in ('succeeded','failed') and finished_at < now() - interval '30 days'`;
}

export async function cancelQueuedDeletesForDeletion(db: SQL): Promise<void> {
  const candidates = await db<Array<{ id: string; organization_id: string }>>`
    select j.id, j.organization_id from profile_delete_jobs j
      where j.status = 'queued' and exists (
        select 1 from tenant_deletions d where d.organization_id = j.organization_id and d.completed_at is null
          and (d.reason = 'account_deleted' or (d.purge_after is not null and d.purge_after <= now()))
      ) limit 32
  `;
  for (const job of candidates) {
    await db.begin(async (tx) => {
      await lockProfileImports(tx, job.organization_id);
      await tx`
        update profile_delete_jobs set status = 'failed', finished_at = now(), updated_at = now(),
          error = ${JSON.stringify({ code: "ACCOUNT_DELETION_PENDING", message: "Suppression annulée : l’organisation est en cours de suppression." })}::text::jsonb
         where id = ${job.id} and status = 'queued'
      `;
    });
  }
}

function publicDeleteFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ProfileDeleteError || error instanceof ProfileImportError) return { code: error.code, message: error.message };
  if (error instanceof HttpError) return { code: error.code, message: error.message };
  if (error instanceof HermesClientError) return { code: error.code, message: error.message };
  return { code: "PROFILE_DELETE_FAILED", message: "La suppression de ce profil n’a pas pu être terminée." };
}
