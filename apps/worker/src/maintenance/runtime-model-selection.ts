import type { SQL } from "bun";
import type { BotProfileModelSyncDto } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { executeRuntimeModelSelectionProof, claimRuntimeModelSelectionProof, type ModelProofJob } from "@openedbot/runtimes/application/model-selection-proof";
import { readRuntimeRowById } from "@openedbot/runtimes/sql/runtime-rows";
import { createRuntimeClient } from "@openedbot/execution/application/runtime-client";
import { withProfileNamesLock } from "@openedbot/portability/application/profile-import-guard";
import { PROFILE_SERVE_WAIT } from "@openedbot/roster/application/profile-provisions";
import { alignProfileModels, followingInDb } from "@openedbot/roster/application/bot-model-reset";
import type { WorkerConfig } from "../config";
import { RELAY_FEATURE_PROFILE_MODEL_BATCH } from "@openedbot/contracts-connector/features";
import { logEvent } from "@openedbot/platform-observability";

export async function processRuntimeModelSelection(db: SQL, config: WorkerConfig, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const job = await claimRuntimeModelSelectionProof(db, config.workerId);
  if (!job) return;
  await withRuntimeModelProofLock(db, job, async () => {
    const client = (proof: ModelProofJob, profile?: string) => createRuntimeClient({
      runtimeId: proof.runtime_id,
      reachability: proof.reachability,
      runtimeEndpoint: proof.endpoint,
      tokenCiphertext: proof.token_ciphertext,
      tokenNonce: proof.token_nonce,
      tokenTag: proof.token_tag,
      tokenKeyId: proof.token_key_id,
      edgeAuthCiphertext: proof.edge_auth_ciphertext,
      edgeAuthNonce: proof.edge_auth_nonce,
      edgeAuthTag: proof.edge_auth_tag,
      edgeAuthKeyId: proof.edge_auth_key_id,
      hermesProfile: profile ?? null,
    }, config);
    await executeRuntimeModelSelectionProof(db, job, {
      client,
      profileServeWait: PROFILE_SERVE_WAIT,
      withProfileNamesLock: (organizationId, names, callback) => withProfileNamesLock(db as unknown as Db, organizationId, names, async () => callback()),
      rewriteFollowers: (promoted, runtimeClient) => alignFollowers(db as unknown as Db, promoted, runtimeClient),
    });
  });
}

export async function withRuntimeModelProofLock(db: SQL, job: ModelProofJob, callback: () => Promise<void>): Promise<boolean> {
  const connection = await db.reserve();
  let acquired = false;
  let reusable = true;
  try {
    const rows = await connection<Array<{ locked: boolean }>>`
      select pg_try_advisory_lock(hashtext('openedbot-model-proof'), hashtext(${job.runtime_id}::text)) as locked
    `;
    acquired = rows[0]?.locked === true;
    if (!acquired) {
      await db`update runtime_model_selection_proofs set status = 'queued', attempts = greatest(attempts - 1, 0),
        next_attempt_at = now() + interval '2 seconds', lease_owner = null, lease_token = null,
        lease_expires_at = null, updated_at = now()
        where runtime_id = ${job.runtime_id} and lease_token = ${job.lease_token}`;
      return false;
    }
    await callback();
    return true;
  } catch (error) {
    if (acquired) {
      try { await connection`select pg_advisory_unlock(hashtext('openedbot-model-proof'), hashtext(${job.runtime_id}::text))`; }
      catch { reusable = false; }
      acquired = false;
    }
    throw error;
  } finally {
    if (acquired) {
      try { await connection`select pg_advisory_unlock(hashtext('openedbot-model-proof'), hashtext(${job.runtime_id}::text))`; }
      catch { reusable = false; }
    }
    if (reusable) connection.release();
    else await connection.close({ timeout: 0 });
  }
}

/**
 * Après la promotion, le bloc `model` des profils gérés qui suivent le runtime
 * s'aligne, par lots quand l'hôte annonce `profile_model_batch`. Best effort :
 * le worker relit et réécrit le profil à chaque run de toute façon.
 */
export async function alignFollowers(db: Db, job: ModelProofJob, runtimeClient: ReturnType<typeof createRuntimeClient>): Promise<void> {
  const candidates = await withTenant(db, job.organization_id, (tx) => tx<Array<{ botId: string; profile: string }>>`
    select b.id as "botId", b.hermes_profile as "profile" from bots b
     where b.organization_id = ${job.organization_id}
       and b.hermes_profile_managed = true
       and b.hermes_profile is not null
       and b.deleted_at is null
       and coalesce((select p.status from bot_profile_provisions p
                      where p.organization_id = b.organization_id and p.bot_id = b.id), 'succeeded') = 'succeeded'
  `);
  if (candidates.length === 0) return;
  const current = await withTenant(db, job.organization_id, async (tx) =>
    (await readRuntimeRowById(tx, job.organization_id, job.runtime_id))[0] ?? null);
  if (!current || current.selectedProvider !== job.provider || current.selectedModel !== job.model) return;
  const sync: BotProfileModelSyncDto = {
    id: crypto.randomUUID(), status: "running", total: candidates.length, done: 0, aligned: 0, failed: 0,
    startedAt: new Date().toISOString(), finishedAt: null,
  };
  const started = performance.now();
  await alignProfileModels(sync, candidates, {
    client: runtimeClient,
    runtime: { selectedProvider: job.provider, selectedModel: job.model },
    batch: job.link_features.includes(RELAY_FEATURE_PROFILE_MODEL_BATCH),
    stillFollowing: followingInDb(db, job.organization_id),
  });
  logEvent("runtime_model_selection.followers", {
    runtimeId: job.runtime_id,
    organizationId: job.organization_id,
    total: sync.total,
    aligned: sync.aligned,
    failed: sync.failed,
    durationMs: Math.round(performance.now() - started),
  });
}
