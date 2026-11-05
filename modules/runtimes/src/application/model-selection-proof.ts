import type { SQL } from "bun";
import { HermesClient, HermesClientError, RelayDialError } from "@openedbot/hermes";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { deleteModelSelectionProof, readModelSelectionProof, upsertModelSelectionProof, upsertProvenRuntimeModel, type RuntimeModelSelectionProof } from "../sql/model-selection-proofs";

export type ModelSelection = { provider: string | null; model: string | null; reasoningEffort: string | null };
export type ModelProofClient = Pick<HermesClient, "createRun" | "getRunStatus" | "stopRun" | "deleteSession">;
export type ModelProofJob = RuntimeModelSelectionProof & {
  reachability: "connector" | "direct"; endpoint: string | null; token_ciphertext: string | null;
  token_nonce: string | null; token_tag: string | null; token_key_id: string | null;
  edge_auth_ciphertext: string | null; edge_auth_nonce: string | null; edge_auth_tag: string | null; edge_auth_key_id: string | null;
  link_features: string[];
};
export const MODEL_CHECK_PROFILE = "openedbot-model-check";
export type ModelProofSpans = { inventoryMs: number; createProfileMs: number; setModelMs: number; isolationMs: number; createRunMs: number; runMs: number; cleanupMs: number; totalMs: number };

export function isTransientProofError(error: unknown): boolean {
  return (error instanceof HermesClientError && (error.status === 429 || error.code === "HERMES_LIMIT_REACHED" || error.code === "HERMES_GATEWAY_DRAINING" || String(error.code) === "RUNTIME_LINK_UNAVAILABLE" || error.requestDelivery === "not_sent")) || error instanceof RelayDialError;
}

function addSpan(spans: ModelProofSpans | undefined, key: keyof ModelProofSpans, started: number): void {
  if (spans) spans[key] += Math.round(performance.now() - started);
}

export function canaryReasoningEffort(effort: string | null): string | null {
  if (effort === null || effort === "none" || effort === "minimal" || effort === "low") return effort;
  return "low";
}

export function readModelSelectionProofState(db: Db, organizationId: string, runtimeId: string) {
  return withTenant(db, organizationId, (tx) => readModelSelectionProof(tx, organizationId, runtimeId));
}

export function cancelModelSelectionProof(db: Db, organizationId: string, runtimeId: string) {
  return withTenant(db, organizationId, (tx) => deleteModelSelectionProof(tx, organizationId, runtimeId));
}

export function enqueueModelSelectionProof(db: Db, input: { organizationId: string; runtimeId: string; provider: string | null; model: string | null; reasoningEffort: string | null }) {
  return withTenant(db, input.organizationId, (tx) => upsertModelSelectionProof(tx, input));
}

export async function readRuntimeModelSelection(db: SQL, organizationId: string, runtimeId: string) {
  return readModelSelectionProof(db, organizationId, runtimeId);
}

export async function proveRuntimeModelSelection(client: ModelProofClient, selection: ModelSelection, spans?: ModelProofSpans): Promise<void> {
  const sessionId = `openedbot-model-canary-${crypto.randomUUID()}`;
  let runId: string | null = null;
  try {
    const createStarted = performance.now();
    try {
      runId = await client.createRun({ input: "Reply with exactly OK.", instructions: "This is a model availability check. Reply with exactly OK and do not use tools.", sessionId, ...selection, reasoningEffort: canaryReasoningEffort(selection.reasoningEffort), promptCacheTtl: "5m" });
    } finally { addSpan(spans, "createRunMs", createStarted); }
    const deadline = Date.now() + 45_000;
    const runStarted = performance.now();
    try {
      while (Date.now() < deadline) {
        const status = await client.getRunStatus(runId);
        if (status.status === "completed") {
          if (status.output?.trim()) return;
          throw new HttpError(409, "RUNTIME_MODEL_CANARY_EMPTY", "Le test d’inférence du modèle s’est terminé sans réponse.");
        }
        if (status.status === "failed" || status.status === "cancelled") {
          throw new HttpError(409, "RUNTIME_MODEL_CANARY_FAILED", "Hermes a enregistré ce modèle, mais son test d’inférence a échoué.");
        }
        await Bun.sleep(250);
      }
    } finally { addSpan(spans, "runMs", runStarted); }
    const stopStarted = performance.now();
    await client.stopRun(runId).catch(() => undefined);
    addSpan(spans, "cleanupMs", stopStarted);
    throw new HttpError(504, "RUNTIME_MODEL_CANARY_TIMEOUT", "Hermes n’a pas terminé le test d’inférence du modèle à temps.");
  } finally {
    const cleanupStarted = performance.now();
    await client.deleteSession(sessionId).catch(() => undefined);
    addSpan(spans, "cleanupMs", cleanupStarted);
  }
}

export async function proveManagedRuntimeModelSelection(
  organizationId: string, clientFactory: (profile?: string) => HermesClient, selection: ModelSelection,
  withProfileNamesLock: (organizationId: string, names: readonly string[], callback: () => Promise<void>) => Promise<void>,
  serveWait: { timeoutMs: number; pollMs: number; sleep(ms: number): Promise<unknown> },
  spans?: ModelProofSpans,
): Promise<void> {
  const client = clientFactory();
  let profiles: { profiles: Array<{ name: string }> };
  const inventoryStarted = performance.now();
  try { profiles = await client.hostProfileInventory(); }
  catch (error) { if (isTransientProofError(error)) throw error; throw new HttpError(502, "RUNTIME_MODEL_CANARY_PROFILE_UNVERIFIED", "Le profil de vérification n’a pas pu être lu."); }
  finally { addSpan(spans, "inventoryMs", inventoryStarted); }
  let profile = profiles.profiles.some((entry) => entry.name === MODEL_CHECK_PROFILE);
  if (!profile) {
    await withProfileNamesLock(organizationId, [MODEL_CHECK_PROFILE], async () => {
      const inventoryStarted = performance.now();
      let current: { profiles: Array<{ name: string }> };
      try { current = await client.hostProfileInventory(); }
      finally { addSpan(spans, "inventoryMs", inventoryStarted); }
      if (current.profiles.some((entry) => entry.name === MODEL_CHECK_PROFILE)) return;
      const createStarted = performance.now();
      try { await client.hostCreateProfile(MODEL_CHECK_PROFILE, { displayName: "openedbot model check" }); }
      finally { addSpan(spans, "createProfileMs", createStarted); }
    });
    profile = true;
    const deadline = Date.now() + serveWait.timeoutMs;
    while (Date.now() < deadline) {
      const isolationStarted = performance.now();
      const isolation = await clientFactory(MODEL_CHECK_PROFILE).probeProfileIsolation(MODEL_CHECK_PROFILE).catch(() => "unreadable" as const);
      addSpan(spans, "isolationMs", isolationStarted);
      if (isolation === "isolated") break;
      await serveWait.sleep(serveWait.pollMs);
    }
  }
  if (selection.provider && selection.model) {
    let applied = false;
    const setStarted = performance.now();
    try { applied = (await client.hostSetProfileModel(MODEL_CHECK_PROFILE, { provider: selection.provider, model: selection.model })).applied; }
    catch (error) { if (isTransientProofError(error)) throw error; applied = false; }
    finally { addSpan(spans, "setModelMs", setStarted); }
    if (!applied) throw new HttpError(409, "RUNTIME_MODEL_CANARY_PROFILE_UNVERIFIED", "Le runtime n’a pas confirmé le modèle pour le test d’inférence.");
  }
  const isolationStarted = performance.now();
  let isolation: Awaited<ReturnType<HermesClient["probeProfileIsolation"]>>;
  try { isolation = await clientFactory(MODEL_CHECK_PROFILE).probeProfileIsolation(MODEL_CHECK_PROFILE); }
  finally { addSpan(spans, "isolationMs", isolationStarted); }
  if (isolation !== "isolated") throw new HttpError(409, "RUNTIME_MODEL_CANARY_PROFILE_UNVERIFIED", "L’isolation du profil de vérification n’est pas confirmée.");
  await proveRuntimeModelSelection(clientFactory(MODEL_CHECK_PROFILE), selection, spans);
}

export async function claimRuntimeModelSelectionProof(db: SQL, workerId: string): Promise<ModelProofJob | null> {
  // The 600-second lease exceeds the worst proof: check profile creation (120 s
  // mutation timeout) and serve wait (45 s), model write (120 s), createRun (30 s),
  // run (45 s) and cleanup. A lease that expired under a live proof would let
  // another claim fence it out (review 2026-10-23).
  const rows = await db<ModelProofJob[]>`
    with candidate as (
      select p.runtime_id from runtime_model_selection_proofs p
       where ((p.status = 'queued' and p.next_attempt_at <= now() and (p.lease_expires_at is null or p.lease_expires_at < now()))
          or (p.status = 'running' and p.lease_expires_at < now()))
       order by p.next_attempt_at for update skip locked limit 1
    )
    update runtime_model_selection_proofs p set status = 'running', attempts = p.attempts + 1,
      lease_owner = ${workerId}, lease_generation = p.lease_generation + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + interval '600 seconds', updated_at = now()
    from candidate c, runtimes r
    where p.runtime_id = c.runtime_id and r.id = p.runtime_id and r.organization_id = p.organization_id
    returning p.*, r.reachability, r.endpoint, r.token_ciphertext, r.token_nonce, r.token_tag, r.token_key_id,
      r.edge_auth_ciphertext, r.edge_auth_nonce, r.edge_auth_tag, r.edge_auth_key_id, r.link_features
  `;
  return rows[0] ?? null;
}

export async function executeRuntimeModelSelectionProof(
  db: Db, job: ModelProofJob, deps: {
    client(job: ModelProofJob, profile?: string): HermesClient;
    withProfileNamesLock(organizationId: string, names: readonly string[], callback: () => Promise<void>): Promise<void>;
    profileServeWait: { timeoutMs: number; pollMs: number; sleep(ms: number): Promise<unknown> };
    rewriteFollowers(job: ModelProofJob, client: HermesClient): Promise<void>;
  },
): Promise<void> {
  const started = Date.now();
  const spans: ModelProofSpans = { inventoryMs: 0, createProfileMs: 0, setModelMs: 0, isolationMs: 0, createRunMs: 0, runMs: 0, cleanupMs: 0, totalMs: 0 };
  const attempt = job.attempts;
  console.info(JSON.stringify({ event: "runtime_model_selection.started", runtimeId: job.runtime_id, organizationId: job.organization_id, attempt, durationMs: 0 }));
  let failure: unknown = null;
  try {
    const base = deps.client(job);
    const selection = { provider: job.provider, model: job.model, reasoningEffort: job.reasoning_effort };
    if (job.provider && job.model && job.link_features.includes("profile_management")) {
      await proveManagedRuntimeModelSelection(job.organization_id, (profile) => deps.client(job, profile), selection, deps.withProfileNamesLock, deps.profileServeWait, spans);
    } else await proveRuntimeModelSelection(base, selection, spans);
  } catch (error) { failure = error; }
  spans.totalMs = Math.round(Date.now() - started);
  await finishRuntimeModelSelectionProof(db, job, failure, started, spans, deps);
}

async function finishRuntimeModelSelectionProof(
  db: Db, job: ModelProofJob, failure: unknown, started: number, spans: ModelProofSpans,
  deps: { client(job: ModelProofJob, profile?: string): HermesClient; withProfileNamesLock(organizationId: string, names: readonly string[], callback: () => Promise<void>): Promise<void>; profileServeWait: { timeoutMs: number; pollMs: number; sleep(ms: number): Promise<unknown> }; rewriteFollowers(job: ModelProofJob, client: HermesClient): Promise<void> },
): Promise<void> {
  const result = await withTenant(db, job.organization_id, async (tx) => {
    const rows = await tx<Array<{ request_id: string; lease_token: string | null; attempts: number; requested_at: Date }>>`
      select request_id, lease_token, attempts, requested_at from runtime_model_selection_proofs
       where organization_id = ${job.organization_id} and runtime_id = ${job.runtime_id} for update
    `;
    const current = rows[0];
    if (!current || current.lease_token !== job.lease_token) return "stale" as const;
    if (current.request_id !== job.request_id) {
      await tx`update runtime_model_selection_proofs set lease_owner = null, lease_token = null, lease_expires_at = null, updated_at = now() where runtime_id = ${job.runtime_id}`;
      return "superseded" as const;
    }
    if (!failure) {
      await tx`update runtimes set selected_provider = ${job.provider}, selected_model = ${job.model}, reasoning_effort = ${job.reasoning_effort}, updated_at = now() where organization_id = ${job.organization_id} and id = ${job.runtime_id}`;
      if (job.provider && job.model) await upsertProvenRuntimeModel(tx, { organizationId: job.organization_id, runtimeId: job.runtime_id, provider: job.provider, model: job.model });
      if (job.provider) await tx`delete from runtime_provider_incidents where organization_id = ${job.organization_id} and runtime_id = ${job.runtime_id} and provider = ${job.provider}`;
      await tx`delete from runtime_model_selection_proofs where organization_id = ${job.organization_id} and runtime_id = ${job.runtime_id}`;
      return "promoted" as const;
    }
    const error = failure instanceof HttpError ? failure : null;
    const transient = isTransientProofError(failure);
    const expired = current.attempts >= 8 || Date.now() - current.requested_at.getTime() >= 300_000;
    if (transient && !expired) {
      const delay = Math.min(2 * 2 ** Math.max(0, current.attempts - 1), 20);
      await tx`update runtime_model_selection_proofs set status = 'queued', next_attempt_at = now() + (${delay} * interval '1 second'), lease_owner = null, lease_token = null, lease_expires_at = null, updated_at = now() where runtime_id = ${job.runtime_id}`;
      return "retry" as const;
    }
    const finalError = transient ? { code: "RUNTIME_MODEL_PROOF_RUNTIME_BUSY", message: "Le runtime est resté occupé : le modèle n’a pas pu être vérifié. Réessayez." }
      : error ? { code: error.code, message: error.message }
      : { code: "RUNTIME_MODEL_PROOF_FAILED", message: "Le test du modèle a échoué." };
    await tx`update runtime_model_selection_proofs set status = 'failed', error = ${finalError}::jsonb, finished_at = now(), lease_owner = null, lease_token = null, lease_expires_at = null, updated_at = now() where runtime_id = ${job.runtime_id}`;
    return "failed" as const;
  });
  if (result === "stale") return;
  const attempt = job.attempts;
  spans.totalMs = Math.round(Date.now() - started);
  console.info(JSON.stringify({ event: `runtime_model_selection.${result}`, runtimeId: job.runtime_id, organizationId: job.organization_id, attempt, spans }));
  if (result === "promoted") {
    // No snapshot invalidation here: openedbot_worker has no access to
    // runtime_read_snapshots (0121, asserted by tests/integration). The
    // promotion bumps runtimes.updated_at and the catalogue route reads its
    // snapshot with notOlderThan = updated_at, so the next read is live.
    try {
      await deps.rewriteFollowers(job, deps.client(job));
    } catch {
      console.info(JSON.stringify({ event: "runtime_model_selection.followers", runtimeId: job.runtime_id, organizationId: job.organization_id, attempt, durationMs: Date.now() - started }));
    }
  }
}
