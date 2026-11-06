import type { SQL, TransactionSQL } from "bun";
import type {
  RuntimeProfileDeleteJobDto,
  RuntimeProfileDeleteJobItemDto,
  RuntimeProfileDeleteJobListDto,
} from "@openedbot/contracts-api";
import { isUniqueViolation } from "@openedbot/platform-db";
import { pgTextArray } from "@openedbot/platform-db/text-array";
import { ProfileDeleteError, ProfileImportError } from "../domain/errors";
import { lockProfileImports } from "./reservations";
import { RELAY_FEATURE_PROFILE_MANAGEMENT } from "@openedbot/contracts-connector/features";

export const DELETE_LEASE_SECONDS = 180;

export type DeleteJobRow = {
  id: string;
  organization_id: string;
  created_by_user_id: string | null;
  runtime_id: string;
  slugs: string[];
  status: RuntimeProfileDeleteJobDto["status"];
  total_profiles: number;
  completed_profiles: number;
  current_slug: string | null;
  results: RuntimeProfileDeleteJobItemDto[] | null;
  error: RuntimeProfileDeleteJobDto["error"];
  lease_owner: string | null;
  lease_generation: number;
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export function publicDeleteJob(row: DeleteJobRow): RuntimeProfileDeleteJobDto {
  return {
    id: row.id,
    runtimeId: row.runtime_id,
    status: row.status,
    slugs: Array.isArray(row.slugs) ? row.slugs : [],
    completedProfiles: row.completed_profiles,
    totalProfiles: row.total_profiles,
    currentSlug: row.current_slug,
    results: Array.isArray(row.results) ? row.results : [],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    error: row.error,
  };
}

async function withDeleteTenant<T>(db: SQL, org: string, callback: (tx: TransactionSQL) => Promise<T>): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${org}, true)`;
    return callback(tx);
  }) as Promise<T>;
}

export async function enqueueProfileDelete(
  db: SQL,
  org: string,
  userId: string,
  runtimeId: string,
  slugs: string[],
): Promise<RuntimeProfileDeleteJobDto> {
  return withDeleteTenant(db, org, async (tx) => {
    await lockProfileImports(tx, org);
    const deleting = await tx<Array<{ organization_id: string }>>`
      select organization_id from tenant_deletions where organization_id = ${org} and completed_at is null
        and (reason = 'account_deleted' or (purge_after is not null and purge_after <= now())) limit 1
    `;
    if (deleting.length) {
      throw new ProfileDeleteError(409, "ACCOUNT_DELETION_PENDING", "La suppression de cette organisation est en cours.");
    }
    const importing = await tx<Array<{ id: string }>>`
      select id from profile_import_jobs where organization_id = ${org} and status in ('queued','running') limit 1
    `;
    if (importing.length) {
      throw new ProfileDeleteError(409, "PROFILE_IMPORT_IN_PROGRESS", "Un import est déjà en cours dans cette organisation.");
    }
    const active = await tx<Array<{ id: string }>>`
      select id from profile_delete_jobs where organization_id = ${org} and status in ('queued','running') limit 1
    `;
    if (active.length) {
      throw new ProfileDeleteError(409, "PROFILE_DELETE_IN_PROGRESS", "Une suppression est déjà en cours dans cette organisation.");
    }
    const runtime = await tx<Array<{ id: string; link_features: string[] }>>`
      select id, link_features from runtimes where organization_id = ${org} and id = ${runtimeId} and is_active = true
    `;
    if (!runtime[0]) throw new ProfileDeleteError(409, "RUNTIME_REQUIRED", "Le runtime de cette suppression n’est plus actif.");
    if (!runtime[0].link_features.includes(RELAY_FEATURE_PROFILE_MANAGEMENT)) {
      throw new ProfileDeleteError(404, "PROFILE_MANAGEMENT_UNAVAILABLE", "Ce runtime n’annonce pas la gestion des profils.");
    }
    const id = crypto.randomUUID();
    try {
      await tx`
        insert into profile_delete_jobs (id, organization_id, created_by_user_id, runtime_id, slugs, total_profiles)
        values (${id}, ${org}, ${userId}, ${runtimeId}, ${pgTextArray(slugs)}::text[], ${slugs.length})
      `;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProfileDeleteError(409, "PROFILE_DELETE_IN_PROGRESS", "Une suppression est déjà en cours dans cette organisation.");
      }
      throw error;
    }
    const rows = await tx<DeleteJobRow[]>`select * from profile_delete_jobs where organization_id = ${org} and id = ${id}`;
    return publicDeleteJob(rows[0]!);
  });
}

/**
 * When a profile import or deletion job of this runtime last changed: the
 * worker changes the host profile list behind these jobs, so a list read
 * before that instant is out of date. Null when the runtime has no such job.
 */
export async function lastProfileJobChange(db: SQL, org: string, runtimeId: string): Promise<Date | null> {
  return withDeleteTenant(db, org, async (tx) => {
    const [row] = await tx<Array<{ changedAt: Date | null }>>`
      select greatest(
        (select max(updated_at) from profile_delete_jobs where organization_id = ${org} and runtime_id = ${runtimeId}),
        (select max(updated_at) from profile_import_jobs where organization_id = ${org} and runtime_id = ${runtimeId})
      ) as "changedAt"
    `;
    return row?.changedAt ?? null;
  });
}

export async function listDeleteJobs(db: SQL, org: string): Promise<RuntimeProfileDeleteJobListDto> {
  return withDeleteTenant(db, org, async (tx) => {
    const active = await tx<DeleteJobRow[]>`
      select * from profile_delete_jobs
       where organization_id = ${org} and status in ('queued','running')
       order by created_at desc, id desc
    `;
    const recent = await tx<DeleteJobRow[]>`
      select * from profile_delete_jobs
       where organization_id = ${org} and status in ('succeeded','failed')
       order by created_at desc, id desc limit 5
    `;
    const jobs = [...new Map([...active, ...recent].map((row) => [row.id, publicDeleteJob(row)])).values()];
    return { jobs };
  });
}

export async function assertNoActiveProfileDelete(tx: TransactionSQL, org: string): Promise<void> {
  const active = await tx<Array<{ id: string }>>`
    select id from profile_delete_jobs where organization_id = ${org} and status in ('queued','running') limit 1
  `;
  if (active.length) {
    throw new ProfileImportError(409, "PROFILE_DELETE_IN_PROGRESS", "Une suppression est déjà en cours dans cette organisation.");
  }
}
