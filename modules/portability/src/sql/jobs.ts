import type { SQL, TransactionSQL } from "bun";
import type { HermesBundleImportDto, HermesBundleImportInput, HermesBundleImportJobDto, HermesBundleImportJobListDto, HermesProfileImportEntry } from "@openedbot/contracts-api";
import { ProfileImportError } from "@openedbot/roster/domain/profile-errors";
import { assertProfileNamesAvailable, lockProfileImports } from "@openedbot/roster/application/profile-reservations";
import { assertNoActiveProfileDelete } from "./delete-jobs";
import type { HostProfileModelSelection } from "@openedbot/roster/application/host-profile-model";
import { RELAY_FEATURE_PROFILE_MANAGEMENT } from "@openedbot/contracts-connector/features";

export const IMPORT_LEASE_SECONDS = 180;
export type ImportJobRow = {
  id: string; organization_id: string; created_by_user_id: string | null;
  runtime_id: string; section_id: string; digest: string;
  status: HermesBundleImportJobDto["status"]; phase: HermesBundleImportJobDto["phase"];
  total_profiles: number; completed_profiles: number;
  result: HermesBundleImportDto | null; error: HermesBundleImportJobDto["error"];
  lease_owner: string | null; lease_generation: number; lease_expires_at: Date | null;
  created_at: Date; updated_at: Date;
};
export type ImportOperation = { kind: "create" | "delete" | "model" | "toolset" | "mcp-server" | "skill"; name?: string; enabled?: boolean };
export type ImportItemRow = {
  job_id: string; organization_id: string; ordinal: number; slug: string;
  entry: HermesProfileImportEntry | null; bot_id: string; thread_id: string;
  avatar_id: string; avatar_stored: boolean;
  creation_state: "not_started" | "sending" | "created" | "not_created" | "deleting" | "deleted" | "unknown";
  operation: ImportOperation | null; selection: HostProfileModelSelection | null; bot_model: string | null;
  limitations: string[]; capabilities_done: boolean;
  completed_operations: string[];
};
export type ImportRuntime = { id: string; selected_provider: string | null; selected_model: string | null; link_features: string[] };

export function emptyImportReport(): HermesBundleImportDto {
  return { imported: [], skipped: [], groups: [], routines: [], limitations: [], capabilities: [] };
}
export function publicImportJob(row: ImportJobRow): HermesBundleImportJobDto {
  return {
    id: row.id, runtimeId: row.runtime_id, status: row.status, phase: row.phase,
    completedProfiles: row.completed_profiles, totalProfiles: row.total_profiles,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    result: row.result, error: row.error,
  };
}

export async function withImportTenant<T>(db: SQL, org: string, callback: (tx: TransactionSQL) => Promise<T>): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${org}, true)`;
    return callback(tx);
  }) as Promise<T>;
}

export function importDigest(input: HermesBundleImportInput): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify({ profiles: input.profiles, sectionId: input.sectionId ?? null })).digest("hex");
}

export async function findIdempotentImport(db: SQL, org: string, input: HermesBundleImportInput): Promise<HermesBundleImportJobDto | null> {
  return withImportTenant(db, org, async (tx) => {
    const rows = await tx<ImportJobRow[]>`select * from profile_import_jobs where organization_id = ${org} and idempotency_key = ${input.idempotencyKey}::uuid`;
    if (!rows[0]) return null;
    if (rows[0].digest !== importDigest(input)) throw new ProfileImportError(409, "PROFILE_IMPORT_KEY_REUSED", "Cette confirmation correspond déjà à un autre import.");
    return publicImportJob(rows[0]);
  });
}

export async function enqueueProfileImport(
  db: SQL, org: string, userId: string, runtimeId: string,
  input: HermesBundleImportInput, limitations: string[] = [],
): Promise<HermesBundleImportJobDto> {
  return withImportTenant(db, org, async (tx) => {
    await lockProfileImports(tx, org);
    const previous = await tx<ImportJobRow[]>`select * from profile_import_jobs where organization_id = ${org} and idempotency_key = ${input.idempotencyKey}::uuid`;
    if (previous[0]) {
      if (previous[0].digest !== importDigest(input)) throw new ProfileImportError(409, "PROFILE_IMPORT_KEY_REUSED", "Cette confirmation correspond déjà à un autre import.");
      return publicImportJob(previous[0]);
    }
    const active = await tx<Array<{ id: string }>>`select id from profile_import_jobs where organization_id = ${org} and status in ('queued','running') limit 1`;
    if (active.length) throw new ProfileImportError(409, "PROFILE_IMPORT_IN_PROGRESS", "Un import est déjà en cours dans cette organisation.");
    await assertNoActiveProfileDelete(tx, org);
    await assertImportTenantAvailable(tx, org);
    const runtime = await tx<ImportRuntime[]>`select id, selected_provider, selected_model, link_features from runtimes where organization_id = ${org} and id = ${runtimeId} and is_active = true`;
    if (!runtime[0]) throw new ProfileImportError(409, "RUNTIME_REQUIRED", "Le runtime de cet import n’est plus actif.");
    if (!runtime[0].link_features.includes(RELAY_FEATURE_PROFILE_MANAGEMENT)) throw new ProfileImportError(404, "PROFILE_MANAGEMENT_UNAVAILABLE", "Ce runtime n’annonce pas la gestion des profils.");
    const sections = input.sectionId
      ? await tx<Array<{ id: string }>>`select id from sections where organization_id = ${org} and id = ${input.sectionId} limit 1`
      : await tx<Array<{ id: string }>>`select id from sections where organization_id = ${org} order by position asc limit 1`;
    const sectionId = sections[0]?.id;
    if (!sectionId) throw new ProfileImportError(input.sectionId ? 404 : 409, input.sectionId ? "TEAM_SECTION_NOT_FOUND" : "TEAM_SECTION_REQUIRED", "La section de cet import est introuvable.");
    const names = input.profiles.map((profile) => profile.name);
    await assertProfileNamesAvailable(tx, org, names);
    await assertImportCollisions(tx, org, names);
    const id = crypto.randomUUID();
    const report = emptyImportReport(); report.limitations = limitations;
    await tx`
      insert into profile_import_jobs (id, organization_id, created_by_user_id, runtime_id, section_id, idempotency_key, digest, total_profiles, result)
      values (${id}, ${org}, ${userId}, ${runtimeId}, ${sectionId}, ${input.idempotencyKey}::uuid, ${importDigest(input)}, ${names.length}, ${JSON.stringify(report)}::text::jsonb)
    `;
    for (const [ordinal, entry] of input.profiles.entries()) {
      await tx`
        insert into profile_import_items (job_id, organization_id, ordinal, slug, entry, bot_id, thread_id, avatar_id)
        values (${id}, ${org}, ${ordinal}, ${entry.name}, ${JSON.stringify(entry)}::text::jsonb, ${crypto.randomUUID()}, ${crypto.randomUUID()}, ${crypto.randomUUID()})
      `;
    }
    const rows = await tx<ImportJobRow[]>`select * from profile_import_jobs where organization_id = ${org} and id = ${id}`;
    return publicImportJob(rows[0]!);
  });
}

export async function assertImportTenantAvailable(tx: TransactionSQL, org: string): Promise<void> {
  const deleting = await tx<Array<{ organization_id: string }>>`
    select organization_id from tenant_deletions where organization_id = ${org} and completed_at is null
      and (reason = 'account_deleted' or (purge_after is not null and purge_after <= now())) limit 1
  `;
  if (deleting.length) throw new ProfileImportError(409, "ACCOUNT_DELETION_PENDING", "La suppression de cette organisation est en cours.");
}

export async function assertImportCollisions(tx: TransactionSQL, org: string, names: string[]): Promise<void> {
  const rows = await tx<Array<{ slug: string; hermes_profile: string | null }>>`
    select slug, hermes_profile from bots where organization_id = ${org}
      and (slug in (select jsonb_array_elements_text(${JSON.stringify(names)}::text::jsonb))
        or hermes_profile in (select jsonb_array_elements_text(${JSON.stringify(names)}::text::jsonb))) limit 1
  `;
  if (rows[0]) throw new ProfileImportError(409, rows[0].hermes_profile && names.includes(rows[0].hermes_profile) ? "PROFILE_ALREADY_IMPORTED" : "TEAM_SLUG_TAKEN", `Un bot utilise déjà le nom ou le profil « ${rows[0].slug} ».`);
}

export async function readImportJob(db: SQL, org: string, id: string): Promise<HermesBundleImportJobDto> {
  return withImportTenant(db, org, async (tx) => {
    const rows = await tx<ImportJobRow[]>`select * from profile_import_jobs where organization_id = ${org} and id = ${id}::uuid`;
    if (!rows[0]) throw new ProfileImportError(404, "PROFILE_IMPORT_NOT_FOUND", "Import introuvable.");
    return publicImportJob(rows[0]);
  });
}

export async function listImportJobs(db: SQL, org: string, cursor: string | null): Promise<HermesBundleImportJobListDto> {
  return withImportTenant(db, org, async (tx) => {
    const rows = await tx<ImportJobRow[]>`
      select * from profile_import_jobs where organization_id = ${org} and status in ('succeeded','failed')
        and (${cursor}::uuid is null or (created_at, id) < (
          select created_at, id from profile_import_jobs where organization_id = ${org} and id = ${cursor}::uuid
        )) order by created_at desc, id desc limit 21
    `;
    const page = rows.slice(0, 20);
    // Always include outstanding work on the first page, even after many later imports.
    const active = cursor ? [] : await tx<ImportJobRow[]>`
      select * from profile_import_jobs where organization_id = ${org} and status in ('queued','running','needs_attention')
      order by created_at desc, id desc
    `;
    const jobs = [...new Map([...active, ...page].map((row) => [row.id, publicImportJob(row)])).values()];
    return { jobs, nextCursor: rows.length > 20 ? page[19]!.id : null };
  });
}

export async function acknowledgeImportJob(db: SQL, org: string, userId: string, id: string): Promise<HermesBundleImportJobDto> {
  return withImportTenant(db, org, async (tx) => {
    await lockProfileImports(tx, org);
    const rows = await tx<Array<ImportJobRow & { acknowledged_at: Date | null; review_ready: boolean }>>`
      select *, (review_after is null or review_after <= now()) as review_ready
      from profile_import_jobs where organization_id = ${org} and id = ${id}::uuid for update
    `;
    const job = rows[0];
    if (!job) throw new ProfileImportError(404, "PROFILE_IMPORT_NOT_FOUND", "Import introuvable.");
    if (job.acknowledged_at) return publicImportJob(job);
    if (job.status !== "needs_attention" || !job.review_ready) throw new ProfileImportError(409, "PROFILE_IMPORT_REVIEW_UNAVAILABLE", "Attendez la fin des opérations avant de confirmer votre vérification sur l’hôte.");
    const status = job.result?.imported.length ? "succeeded" : "failed";
    const result = job.result ?? emptyImportReport();
    result.limitations.push("profile-import-reviewed");
    await tx`update profile_import_items set reservation_released_at = now(), entry = null, operation = null where organization_id = ${org} and job_id = ${id}`;
    const updated = await tx<ImportJobRow[]>`
      update profile_import_jobs set status = ${status}, phase = 'finished', acknowledged_at = now(), acknowledged_by = ${userId},
        finished_at = now(), updated_at = now(), lease_owner = null, lease_expires_at = null, lease_generation = lease_generation + 1,
        result = ${JSON.stringify(result)}::text::jsonb
      where organization_id = ${org} and id = ${id} returning *
    `;
    return publicImportJob(updated[0]!);
  });
}
