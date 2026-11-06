import type { SQL, TransactionSQL } from "bun";
import { HermesClientError, type HermesClient, type HermesHostProfile, type HermesModelOptions, type HermesProfileAvatar } from "@openedbot/hermes";
import { ALWAYS_FORBIDDEN_TOOLSETS } from "@openedbot/runtimes/domain/runtime-contract";
import type { HermesBundleImportJobDto } from "@openedbot/contracts-api";
import { ProfileImportError } from "../domain/errors";
import {
  assertImportCollisions, assertImportTenantAvailable, emptyImportReport, IMPORT_LEASE_SECONDS,
  type ImportItemRow, type ImportJobRow, type ImportOperation, type ImportRuntime,
} from "../sql/jobs";
import { resolveImportedModel } from "./model";
import { profileCreationFailureState } from "./provision";
import { lockProfileImports } from "../sql/reservations";
import { createImportedGroups, importHermesProfile, importObjectKey, type ImportBlobStore } from "../sql/roster";
import { RELAY_FEATURE_PROFILE_CAPABILITIES, RELAY_FEATURE_PROFILE_MANAGEMENT } from "@openedbot/contracts-connector/features";

export type ImportExecutorClient = Pick<HermesClient,
  "hostCreateProfile" | "hostDeleteProfile" | "hostSetProfileModel" | "hostProfileInventory" |
  "probeProfileIsolation" | "modelOptions" | "mcpInventory" |
  "hostSetProfileToolset" | "hostSetProfileMcpServer" | "hostSetProfileSkill"
>;
export type ImportExecutorDependencies = {
  client(runtimeId: string, profile?: string): ImportExecutorClient;
  blobs: ImportBlobStore;
  signal?: AbortSignal;
};
export class ImportLeaseLost extends Error {}
class AmbiguousImportMutation extends Error {}

export async function claimProfileImport(db: SQL, workerId: string): Promise<ImportJobRow | null> {
  const rows = await db<ImportJobRow[]>`
    with candidate as (
      select id from profile_import_jobs where status in ('queued','running')
        and (lease_expires_at is null or lease_expires_at <= now())
      order by created_at asc, id asc for update skip locked limit 1
    )
    update profile_import_jobs j set status = 'running', lease_owner = ${workerId},
      lease_generation = j.lease_generation + 1,
      lease_expires_at = now() + (${IMPORT_LEASE_SECONDS} * interval '1 second'), updated_at = now()
    from candidate where j.id = candidate.id returning j.*
  `;
  return rows[0] ?? null;
}

export async function executeProfileImport(db: SQL, claimed: ImportJobRow, deps: ImportExecutorDependencies): Promise<void> {
  let lost = false;
  let renewing = false;
  // Both clocks fence a suspended process; a heartbeat extends the deadline only
  // after its SQL renewal succeeds, using its start time conservatively.
  let deadline = Math.min(Date.now() + IMPORT_LEASE_SECONDS * 1000, new Date(claimed.lease_expires_at!).getTime());
  let monotonicDeadline = performance.now() + Math.max(0, deadline - Date.now());
  const checkLocal = () => { if (lost || Date.now() >= deadline || performance.now() >= monotonicDeadline || deps.signal?.aborted) throw new ImportLeaseLost(); };
  const guarded = async <T>(fn: (tx: TransactionSQL, job: ImportJobRow) => Promise<T>): Promise<T> => {
    checkLocal();
    return db.begin(async (tx) => {
      await lockProfileImports(tx, claimed.organization_id);
      const rows = await tx<ImportJobRow[]>`
        select * from profile_import_jobs where id = ${claimed.id} and organization_id = ${claimed.organization_id}
          and status = 'running' and lease_owner = ${claimed.lease_owner} and lease_generation = ${claimed.lease_generation}
          and lease_expires_at > now() for update
      `;
      if (!rows[0]) { lost = true; throw new ImportLeaseLost(); }
      checkLocal();
      return fn(tx, rows[0]);
    }) as Promise<T>;
  };
  const heartbeat = setInterval(() => {
    if (renewing || lost || deps.signal?.aborted) return;
    renewing = true;
    const renewalStarted = Date.now();
    const renewalMonotonic = performance.now();
    void db<Array<{ id: string }>>`
      update profile_import_jobs set lease_expires_at = now() + (${IMPORT_LEASE_SECONDS} * interval '1 second')
      where id = ${claimed.id} and status = 'running' and lease_owner = ${claimed.lease_owner}
        and lease_generation = ${claimed.lease_generation} and lease_expires_at > now() returning id
    `.then((rows) => { if (!rows.length) lost = true; else { deadline = renewalStarted + IMPORT_LEASE_SECONDS * 1000; monotonicDeadline = renewalMonotonic + IMPORT_LEASE_SECONDS * 1000; } }).catch(() => { lost = true; }).finally(() => { renewing = false; });
  }, 10_000);

  const itemsIn = (tx: TransactionSQL) => tx<ImportItemRow[]>`
    select * from profile_import_items where organization_id = ${claimed.organization_id} and job_id = ${claimed.id} order by ordinal
  `;
  const snapshot = () => guarded(async (tx, job) => ({ job, items: await itemsIn(tx) }));
  const root = deps.client(claimed.runtime_id);
  let catalog: Promise<HermesModelOptions> | undefined;
  const loadCatalog = () => catalog ??= root.modelOptions();

  async function runtimeIn(tx: TransactionSQL): Promise<ImportRuntime> {
    await assertImportTenantAvailable(tx, claimed.organization_id);
    const rows = await tx<ImportRuntime[]>`
      select id, selected_provider, selected_model, link_features from runtimes
      where organization_id = ${claimed.organization_id} and id = ${claimed.runtime_id} and is_active = true
    `;
    if (!rows[0]) throw new ProfileImportError(409, "RUNTIME_REQUIRED", "Le runtime de cet import n’est plus actif.");
    return rows[0];
  }

  async function note(item: ImportItemRow, ...limitations: string[]): Promise<void> {
    item.limitations = [...new Set([...item.limitations, ...limitations])];
    await guarded(async (tx) => {
      await tx`update profile_import_items set limitations = ${JSON.stringify(item.limitations)}::text::jsonb, updated_at = now() where job_id = ${claimed.id} and ordinal = ${item.ordinal}`;
    });
  }

  async function intent(item: ImportItemRow, operation: ImportOperation): Promise<void> {
    await guarded(async (tx) => {
      if (operation.kind !== "delete") await runtimeIn(tx);
      await tx`
        update profile_import_items set operation = ${JSON.stringify(operation)}::text::jsonb,
          creation_state = ${operation.kind === "create" ? "sending" : operation.kind === "delete" ? "deleting" : item.creation_state}, updated_at = now()
        where job_id = ${claimed.id} and ordinal = ${item.ordinal}
      `;
    });
    item.operation = operation;
    checkLocal();
  }

  async function confirmed(item: ImportItemRow, key: string, state = item.creation_state): Promise<void> {
    item.creation_state = state;
    item.completed_operations = [...new Set([...item.completed_operations, key])];
    await guarded(async (tx) => {
      await tx`
        update profile_import_items set operation = null, creation_state = ${state},
          completed_operations = ${JSON.stringify(item.completed_operations)}::text::jsonb,
          limitations = ${JSON.stringify(item.limitations)}::text::jsonb, updated_at = now()
        where job_id = ${claimed.id} and ordinal = ${item.ordinal}
      `;
    });
    item.operation = null;
  }

  async function flagMutation(item: ImportItemRow, operation: ImportOperation, call: () => Promise<{ applied: boolean }>): Promise<void> {
    const key = `${operation.kind}:${operation.name ?? ""}`;
    if (item.completed_operations.includes(key)) return;
    await intent(item, operation);
    try {
      checkLocal();
      const result = await call();
      if (!result.applied) item.limitations.push(`${operation.kind}-not-applied:${item.slug}${operation.name ? `:${operation.name}` : ""}`);
      if (operation.kind === "mcp-server") item.limitations.push(`mcp-restart-pending:${item.slug}`);
    } catch (error) {
      if (error instanceof ImportLeaseLost) throw error;
      if (mutationOutcomeUnknown(error)) throw new AmbiguousImportMutation();
      item.limitations.push(`${operation.kind}-write-failed:${item.slug}${operation.name ? `:${operation.name}` : ""}`);
    }
    await confirmed(item, key);
  }

  async function prepare(): Promise<void> {
    const { job, items } = await snapshot();
    if (items.some((item) => item.operation !== null)) throw new AmbiguousImportMutation();
    if (job.phase !== "prevalidation") return;
    const runtime = await guarded((tx) => runtimeIn(tx));
    if (!runtime.link_features.includes(RELAY_FEATURE_PROFILE_MANAGEMENT)) throw new ProfileImportError(404, "PROFILE_MANAGEMENT_UNAVAILABLE", "Ce runtime n’annonce pas la gestion des profils.");
    for (const item of items) {
      if (!item.entry) throw new Error("Missing import projection");
      const resolved = await resolveImportedModel(item.entry, { selectedModel: runtime.selected_model, selectedProvider: runtime.selected_provider }, loadCatalog);
      item.selection = resolved.selection; item.bot_model = resolved.model;
      item.limitations.push(...resolved.limitations);
    }
    await guarded(async (tx) => {
      await runtimeIn(tx);
      for (const item of items) await tx`
        update profile_import_items set selection = ${JSON.stringify(item.selection)}::text::jsonb, bot_model = ${item.bot_model},
          limitations = ${JSON.stringify(item.limitations)}::text::jsonb where job_id = ${claimed.id} and ordinal = ${item.ordinal}
      `;
      await tx`update profile_import_jobs set phase = 'creation', updated_at = now() where id = ${claimed.id}`;
    });
  }

  async function createProfiles(): Promise<void> {
    const { job, items } = await snapshot();
    if (!["creation", "roster"].includes(job.phase)) return;
    for (const item of items) {
      if (!item.entry) throw new Error("Missing import projection");
      let created: HermesHostProfile | null = null;
      if (item.creation_state === "not_started") {
        await intent(item, { kind: "create" });
        try {
          checkLocal();
          created = await root.hostCreateProfile(item.slug, { displayName: item.entry.displayName, ...item.selection });
        } catch (error) {
          const state = profileCreationFailureState(error);
          if (state === "unknown") throw new AmbiguousImportMutation();
          await confirmed(item, "create", state);
          throw error;
        }
        await confirmed(item, "create", "created");
      }
      if (item.creation_state !== "created") throw new Error("Import creation was not confirmed");
      const isolation = await deps.client(claimed.runtime_id, item.slug).probeProfileIsolation(item.slug);
      if (isolation !== "isolated") throw new ProfileImportError(502, "HERMES_PROFILE_CREATE_FAILED", "L’isolation du profil créé n’a pas pu être prouvée.");
      if (item.selection && !(created?.model.default === item.selection.model && created.model.provider === item.selection.provider)) {
        await flagMutation(item, { kind: "model" }, () => root.hostSetProfileModel(item.slug, item.selection!));
      }
      if (item.entry.avatar && !item.avatar_stored) {
        const bytes = Uint8Array.from(atob(item.entry.avatar.base64), (char) => char.charCodeAt(0));
        checkLocal();
        try {
          await deps.blobs.put(importObjectKey(claimed.organization_id, item.avatar_id), bytes, item.entry.avatar.contentType);
          item.avatar_stored = true;
        } catch (error) {
          if (error instanceof ImportLeaseLost) throw error;
          await note(item, `avatar-not-imported:${item.slug}`);
        }
        if (item.avatar_stored) await guarded(async (tx) => {
          await tx`update profile_import_items set avatar_stored = true where job_id = ${claimed.id} and ordinal = ${item.ordinal}`;
        });
      }
      await guarded(async (tx) => {
        await tx`update profile_import_jobs set completed_profiles = ${item.ordinal + 1}, updated_at = now() where id = ${claimed.id}`;
      });
    }
    await guarded(async (tx) => { await tx`update profile_import_jobs set phase = 'roster', updated_at = now() where id = ${claimed.id}`; });
  }

  async function materialize(): Promise<void> {
    await guarded(async (tx, job) => {
      if (job.phase !== "roster") return;
      await runtimeIn(tx);
      if (!job.created_by_user_id) throw new ProfileImportError(409, "PROFILE_IMPORT_AUTHOR_MISSING", "L’auteur de cet import n’existe plus.");
      const sections = await tx<Array<{ id: string }>>`select id from sections where organization_id = ${job.organization_id} and id = ${job.section_id} limit 1`;
      if (!sections.length) throw new ProfileImportError(404, "TEAM_SECTION_NOT_FOUND", "La section de cet import n’existe plus.");
      const items = await itemsIn(tx);
      if (items.some((item) => item.creation_state !== "created" || item.operation || !item.entry)) throw new AmbiguousImportMutation();
      const reservations = await tx<Array<{ slug: string }>>`select slug from profile_import_items where job_id = ${job.id} and reservation_released_at is null`;
      if (reservations.length !== items.length) throw new ImportLeaseLost();
      await assertImportCollisions(tx, job.organization_id, items.map((item) => item.slug));
      const positions = await tx<Array<{ next: number }>>`select coalesce(max(position), -1) + 1 as next from bots where organization_id = ${job.organization_id} and section_id = ${job.section_id}`;
      const groupPositions = await tx<Array<{ next: number }>>`select coalesce(max(position), -1) + 1 as next from bot_groups where organization_id = ${job.organization_id} and section_id = ${job.section_id}`;
      let position = Number(positions[0]?.next ?? 0);
      const report = job.result ?? emptyImportReport();
      const members = new Map<string, Array<{ botId: string; slug: string }>>();
      for (const item of items) {
        const entry = item.entry!;
        const avatar: HermesProfileAvatar | null = item.avatar_stored && entry.avatar
          ? { contentType: entry.avatar.contentType, bytes: Uint8Array.from(atob(entry.avatar.base64), (char) => char.charCodeAt(0)) } : null;
        const imported = await importHermesProfile(tx, {
          organizationId: job.organization_id, userId: job.created_by_user_id, sectionId: job.section_id,
          position: position++, managed: true, model: item.bot_model, botId: item.bot_id, threadId: item.thread_id,
          avatarId: item.avatar_id, avatarStored: item.avatar_stored,
        }, entry, avatar, deps.blobs);
        report.imported.push({ slug: item.slug, botId: imported.botId, threadId: imported.threadId, name: imported.name });
        report.routines.push(...imported.routines); report.limitations.push(...item.limitations, ...imported.limitations);
        for (const group of imported.groups) {
          const list = members.get(group) ?? []; list.push({ slug: item.slug, botId: item.bot_id }); members.set(group, list);
        }
      }
      const grouped = await createImportedGroups(tx, { organizationId: job.organization_id, sectionId: job.section_id, position: Number(groupPositions[0]?.next ?? 0) }, members);
      report.groups = grouped.groups; report.limitations.push(...grouped.limitations);
      // The job phase is the durable commit witness. Never delete host profiles based on an ACK loss.
      await tx`update profile_import_jobs set phase = 'capabilities', completed_profiles = 0, result = ${JSON.stringify(report)}::text::jsonb, updated_at = now() where id = ${job.id}`;
    });
  }

  async function capabilities(): Promise<void> {
    const { job, items } = await snapshot();
    if (job.phase !== "capabilities") return;
    const runtime = await guarded((tx) => runtimeIn(tx));
    let mcpNames: Set<string> | null = null;
    try { mcpNames = new Set((await root.mcpInventory()).servers.map((server) => server.name)); } catch { /* Each requested MCP is reported as unverified. */ }
    for (const item of items) {
      if (item.capabilities_done) continue;
      const entry = item.entry!;
      let before: HermesHostProfile | undefined;
      try { before = (await root.hostProfileInventory()).profiles.find((profile) => profile.name === item.slug); }
      catch { await note(item, `capabilities-reread-failed:${item.slug}`); }
      if (!runtime.link_features.includes(RELAY_FEATURE_PROFILE_CAPABILITIES)) await note(item, `per-bot-capabilities-not-applied:${item.slug}`);
      else {
        for (const flag of entry.toolsets) {
          if (ALWAYS_FORBIDDEN_TOOLSETS.has(flag.name)) { await note(item, `toolset-forbidden:${item.slug}:${flag.name}`); continue; }
          await flagMutation(item, { kind: "toolset", ...flag }, () => root.hostSetProfileToolset(item.slug, flag.name, flag.enabled));
        }
        for (const flag of entry.mcpServers) {
          if (!mcpNames?.has(flag.name)) { await note(item, `${mcpNames ? "mcp-server-unknown" : "mcp-inventory-unavailable"}:${item.slug}:${flag.name}`); continue; }
          await flagMutation(item, { kind: "mcp-server", ...flag }, () => root.hostSetProfileMcpServer(item.slug, flag.name, flag.enabled));
        }
        for (const flag of entry.skills) {
          if (flag.name === "hermes-agent" && !flag.enabled) { await note(item, `skill-essential:${item.slug}:${flag.name}`); continue; }
          if (!before?.skills.some((skill) => skill.name === flag.name)) { await note(item, `skill-content-not-imported:${item.slug}:${flag.name}`); continue; }
          await note(item, `skill-content-unverified:${item.slug}:${flag.name}`);
          await flagMutation(item, { kind: "skill", ...flag }, () => root.hostSetProfileSkill(item.slug, flag.name, flag.enabled));
        }
      }
      let after: HermesHostProfile | undefined;
      try { after = (await root.hostProfileInventory()).profiles.find((profile) => profile.name === item.slug); }
      catch { /* No snapshot is invented on failed re-read. */ }
      if (!after || after.toolsets.some((flag) => flag.name === "api_server")) {
        await note(item, `capabilities-reread-failed:${item.slug}`);
        after = undefined;
      } else {
        for (const kind of ["toolsets", "mcpServers", "skills"] as const) {
          for (const flag of after[kind]) if (!entry[kind].some((wanted) => wanted.name === flag.name)) await note(item, `capability-inherited:${item.slug}:${kind}:${flag.name}`);
        }
      }
      await guarded(async (tx, current) => {
        const report = current.result!;
        report.limitations.push(...item.limitations);
        if (after) report.capabilities.push({ slug: item.slug, toolsets: after.toolsets, mcpServers: after.mcpServers, skills: after.skills });
        await tx`update profile_import_items set capabilities_done = true where job_id = ${claimed.id} and ordinal = ${item.ordinal}`;
        await tx`update profile_import_jobs set result = ${JSON.stringify(report)}::text::jsonb, completed_profiles = ${item.ordinal + 1}, updated_at = now() where id = ${claimed.id}`;
      });
    }
    await finish("succeeded", null);
  }

  async function finish(status: "succeeded" | "failed", error: HermesBundleImportJobDto["error"]): Promise<void> {
    await guarded(async (tx, job) => {
      const items = await itemsIn(tx);
      if (items.some((item) => item.operation)) throw new AmbiguousImportMutation();
      const report = job.result ?? emptyImportReport();
      report.limitations = [...new Set([...report.limitations, ...items.flatMap((item) => item.limitations)])];
      await queueUnusedAvatars(tx, job.id);
      await tx`update profile_import_items set entry = null, reservation_released_at = now() where job_id = ${job.id}`;
      await tx`
        update profile_import_jobs set status = ${status}, phase = 'finished', result = ${JSON.stringify(report)}::text::jsonb, error = ${JSON.stringify(error)}::text::jsonb,
          finished_at = now(), updated_at = now(), lease_owner = null, lease_expires_at = null where id = ${job.id}
      `;
    });
  }

  async function attention(): Promise<void> {
    await guarded(async (tx, job) => {
      const items = await itemsIn(tx);
      const slugs = items.filter((item) => item.operation || ["created", "sending", "deleting", "unknown"].includes(item.creation_state)).map((item) => item.slug);
      const report = job.result ?? emptyImportReport();
      report.limitations = [...new Set([...report.limitations, ...items.flatMap((item) => item.limitations)])];
      const error = { code: "PROFILE_IMPORT_UNCONFIRMED", message: "L’issue d’une opération Hermes est incertaine. Vérifiez les profils sur l’hôte avant de poursuivre.", details: { unconfirmedProfiles: slugs } };
      await queueUnusedAvatars(tx, job.id);
      await tx`update profile_import_items set entry = null where job_id = ${job.id}`;
      await tx`
        update profile_import_jobs set status = 'needs_attention', error = ${JSON.stringify(error)}::text::jsonb,
          result = ${JSON.stringify(report)}::text::jsonb, review_after = now() + interval '120 seconds',
          updated_at = now(), lease_owner = null, lease_expires_at = null where id = ${job.id}
      `;
    });
  }

  async function compensate(error: unknown): Promise<void> {
    const { job, items } = await snapshot();
    const failure = job.phase === "compensation" && job.error ? job.error : publicFailure(error);
    if (items.some((item) => item.operation)) { await attention(); return; }
    if (job.phase === "capabilities") {
      // Roster committed: host cleanup would destroy profiles now owned by bots.
      await guarded(async (tx, current) => {
        const report = current.result!;
        for (const item of items.filter((candidate) => !candidate.capabilities_done)) report.limitations.push(`per-bot-capabilities-not-applied:${item.slug}`);
        await tx`update profile_import_jobs set result = ${JSON.stringify(report)}::text::jsonb where id = ${current.id}`;
      });
      await finish("succeeded", null); return;
    }
    await guarded(async (tx) => { await tx`update profile_import_jobs set phase = 'compensation', error = ${JSON.stringify(failure)}::text::jsonb, updated_at = now() where id = ${claimed.id}`; });
    for (const item of [...items].reverse()) {
      if (item.creation_state === "created") {
        await intent(item, { kind: "delete" });
        try { checkLocal(); await root.hostDeleteProfile(item.slug); }
        catch (failure) {
          if (!(failure instanceof HermesClientError && failure.code === "PROFILE_NOT_FOUND")) { await attention(); return; }
        }
        await confirmed(item, "delete", "deleted");
      }
      try { await deps.blobs.delete(importObjectKey(claimed.organization_id, item.avatar_id)); }
      catch { await note(item, `avatar-cleanup-unconfirmed:${item.slug}`); }
    }
    await finish("failed", failure);
  }

  try {
    const initial = await snapshot();
    if (initial.items.some((item) => item.operation)) { await attention(); return; }
    if (initial.job.phase === "compensation") { await compensate(initial.job.error); return; }
    await prepare();
    await createProfiles();
    await materialize();
    await capabilities();
  } catch (error) {
    if (error instanceof ImportLeaseLost || lost || deps.signal?.aborted) return;
    try {
      if (error instanceof AmbiguousImportMutation) await attention();
      else await compensate(error);
    } catch {
      // DB/lease uncertainty: leave the journal intact for the next claimant.
      // No host mutation is attempted without a durable decision.
    }
  } finally {
    clearInterval(heartbeat);
  }
}

function mutationOutcomeUnknown(error: unknown): boolean {
  return !(error instanceof HermesClientError)
    || error.requestDelivery === "ambiguous"
    || (error.requestDelivery !== "not_sent" && error.requestDelivery !== "response_received")
    || error.code === "HERMES_RESPONSE_INVALID" || error.code === "HERMES_STREAM_INTERRUPTED";
}
function publicFailure(error: unknown): NonNullable<HermesBundleImportJobDto["error"]> {
  if (error instanceof ProfileImportError) return { code: error.code, message: error.message, details: error.details };
  if (error instanceof HermesClientError && error.code === "PROFILE_EXISTS") return { code: "HERMES_PROFILE_EXISTS", message: "Un profil existe déjà sur l’hôte. Utilisez l’import depuis le runtime." };
  const pg = error as { code?: string; errno?: string } | null;
  if (pg?.code === "23505" || pg?.errno === "23505") return { code: "PROFILE_ALREADY_IMPORTED", message: "Un profil de cet import est déjà lié à un bot." };
  return { code: "HERMES_PROFILE_CREATE_FAILED", message: "L’import n’a pas pu être terminé. Consultez ses limitations avant de réessayer." };
}

export async function purgeOldProfileImports(db: SQL): Promise<void> {
  await db`delete from profile_import_jobs where status in ('succeeded','failed') and finished_at < now() - interval '30 days'`;
}

async function queueUnusedAvatars(tx: TransactionSQL, jobId: string): Promise<void> {
  await tx`
    insert into tenant_blob_deletions (object_key, organization_id)
    select 'org/' || i.organization_id::text || '/' || i.avatar_id::text, i.organization_id
      from profile_import_items i where i.job_id = ${jobId}
        and not exists (select 1 from attachments a where a.organization_id = i.organization_id and a.id = i.avatar_id)
    on conflict (object_key) do nothing
  `;
}

export async function cancelQueuedImportsForDeletion(db: SQL): Promise<void> {
  const candidates = await db<Array<{ id: string; organization_id: string }>>`
    select j.id, j.organization_id from profile_import_jobs j
      where j.status = 'queued' and exists (
        select 1 from tenant_deletions d where d.organization_id = j.organization_id and d.completed_at is null
          and (d.reason = 'account_deleted' or (d.purge_after is not null and d.purge_after <= now()))
      ) limit 32
  `;
  for (const job of candidates) await db.begin(async (tx) => {
    await lockProfileImports(tx, job.organization_id);
    const updated = await tx<Array<{ id: string }>>`
      update profile_import_jobs set status = 'failed', phase = 'finished', finished_at = now(), updated_at = now(),
        error = ${{ code: "ACCOUNT_DELETION_PENDING", message: "Import annulé avant toute création : l’organisation est en cours de suppression." }}
      where id = ${job.id} and status = 'queued' returning id
    `;
    if (updated.length) await tx`update profile_import_items set entry = null, reservation_released_at = now() where job_id = ${job.id}`;
  });
}
