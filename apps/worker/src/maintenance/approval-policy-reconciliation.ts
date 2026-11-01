import type { SQL } from "bun";
import { HermesClientError, type HermesProfileInventory } from "@openedbot/hermes";
import { applyHostApprovalPolicyWithClient, effectiveHostPolicy, hostBlockedToolsMatch } from "@openedbot/roster/application/approval-policy";
import { readBlockedTools } from "@openedbot/roster/sql/tool-policies";
import type { BotPermissionMode } from "@openedbot/contracts-api";
import { approvalPolicyMode, permissionPipelineOf } from "@openedbot/runtimes/domain/runtime-contract";
import { createRuntimeClient } from "@openedbot/execution/application/runtime-client";
import { withBotProfileLock } from "@openedbot/portability/application/profile-import-guard";
import type { Db } from "@openedbot/platform-db";
import type { WorkerConfig } from "../config";

const BATCH_SIZE = 50;
const APPROVAL_POLICY_RECHECK_MS = 10 * 60_000;
const APPROVAL_POLICY_RETRY_BASE_MS = 30_000;
const APPROVAL_POLICY_RETRY_MAX_MS = 15 * 60_000;
let cursor: { organizationId: string; botId: string } | null = null;
const failuresByBot = new Map<string, { failures: number; nextAttemptAt: number }>();

function hasRecentProof(bot: {
  permission_mode: BotPermissionMode;
  permission_pipeline: string;
  approval_policy_mode: string | null;
  approval_policy_effective_at: Date | null;
}, nowMs: number): boolean {
  return bot.approval_policy_mode === approvalPolicyMode(bot.permission_mode, permissionPipelineOf(bot.permission_pipeline))
    && bot.approval_policy_effective_at !== null
    && nowMs - bot.approval_policy_effective_at.getTime() < APPROVAL_POLICY_RECHECK_MS;
}

function recordFailure(key: string, nowMs: number): number {
  const failures = (failuresByBot.get(key)?.failures ?? 0) + 1;
  const delay = Math.min(APPROVAL_POLICY_RETRY_MAX_MS, APPROVAL_POLICY_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 5));
  failuresByBot.set(key, { failures, nextAttemptAt: nowMs + delay });
  return failures;
}

/** Reconciles bounded batches of managed profiles before relying on host enforcement. */
export async function reconcileHostApprovalPolicies(
  db: SQL,
  config: WorkerConfig,
  signal?: AbortSignal,
  clientFactory: typeof createRuntimeClient = createRuntimeClient,
  lockProfile: <T>(organizationId: string, botId: string, run: () => Promise<T>) => Promise<T> =
    (organizationId, botId, run) => withBotProfileLock(db as unknown as Db, organizationId, botId, () => run()),
  now: () => number = Date.now,
): Promise<void> {
  const bots = await db<Array<{
    bot_id: string;
    organization_id: string;
    runtime_id: string;
    profile: string;
    permission_mode: BotPermissionMode;
    permission_pipeline: string;
    approval_policy_mode: string | null;
    approval_policy_effective_at: Date | null;
  }>>`
    select b.id as bot_id, b.organization_id, rt.id as runtime_id,
           b.hermes_profile as profile, b.permission_mode, o.permission_pipeline,
           b.approval_policy_mode, b.approval_policy_effective_at
      from bots b
      join organizations o on o.id = b.organization_id
      join runtimes rt on rt.organization_id = b.organization_id and rt.is_active and rt.revoked_at is null
     where b.hermes_profile_managed
       and b.hermes_profile is not null
       and b.deleted_at is null
       and rt.reachability = 'connector'
       and rt.link_features @> array['approval_policy']::text[]
       and (${cursor?.organizationId ?? ""} = '' or (b.organization_id::text, b.id::text) > (${cursor?.organizationId ?? ""}, ${cursor?.botId ?? ""}))
       and not exists (
         select 1 from bot_profile_provisions p
          where p.organization_id = b.organization_id and p.bot_id = b.id and p.status in ('queued','running')
       )
     order by b.organization_id::text, b.id::text
     limit ${BATCH_SIZE}
  `;
  if (!bots.length) {
    cursor = null;
    return;
  }
  const profileInventories = new Map<string, Promise<HermesProfileInventory>>();
  for (const bot of bots) {
    if (signal?.aborted) return;
    cursor = { organizationId: bot.organization_id, botId: bot.bot_id };
    const key = `${bot.organization_id}:${bot.bot_id}`;
    const nowMs = now();
    if (hasRecentProof(bot, nowMs)) {
      failuresByBot.delete(key);
      continue;
    }
    if ((failuresByBot.get(key)?.nextAttemptAt ?? 0) > nowMs) continue;
    try {
      const client = clientFactory({
        runtimeId: bot.runtime_id,
        reachability: "connector",
        runtimeEndpoint: null,
        tokenCiphertext: null,
        tokenNonce: null,
        tokenTag: null,
        tokenKeyId: null,
        hermesProfile: bot.profile,
      }, config);
      let inventoryPromise = profileInventories.get(bot.runtime_id);
      if (!inventoryPromise) {
        inventoryPromise = client.hostProfileInventory();
        profileInventories.set(bot.runtime_id, inventoryPromise);
      }
      const inventory = await inventoryPromise;
      if (!inventory.profiles.some((profile) => profile.name === bot.profile)) {
        recordFailure(key, now());
        console.info(JSON.stringify({
          event: "worker.approval_policy_profile_missing",
          botId: bot.bot_id,
          organizationId: bot.organization_id,
          profile: bot.profile,
        }));
        continue;
      }
      // Même verrou que `updateBot` : sans lui, une passe lancée avant un
      // passage en manuel réécrivait `off` à partir d'un mode périmé (lab,
      // 2026-10-22). Le mode est relu sous le verrou.
      const handled = await lockProfile(bot.organization_id, bot.bot_id, async () => {
      const fresh = await db<Array<{ permission_mode: BotPermissionMode; permission_pipeline: string }>>`
        select b.permission_mode, o.permission_pipeline
          from bots b join organizations o on o.id = b.organization_id
         where b.organization_id = ${bot.organization_id} and b.id = ${bot.bot_id} and b.deleted_at is null
      `;
      if (!fresh[0]) return false;
      bot.permission_mode = fresh[0].permission_mode;
      bot.permission_pipeline = fresh[0].permission_pipeline;
      if (hasRecentProof(bot, now())) return false;
      let state: Awaited<ReturnType<typeof client.hostApprovalPolicy>> | null = null;
      try { state = await client.hostApprovalPolicy(bot.profile); } catch { /* A missing policy is repaired by the named setter below. */ }
      const pipeline = permissionPipelineOf(bot.permission_pipeline);
      const target = approvalPolicyMode(bot.permission_mode, pipeline);
      // PERM2-5: the profile must hold exactly the stored blocked keys.
      const blocked = await readBlockedTools(db, bot.organization_id, bot.bot_id);
      // PERM2-A: under `v2` a profile still holding the older plugin is
      // rewritten too. Only a write installs the current bundle (and marks the
      // gateway restart that loads it); a read alone would leave the bot
      // unproven for good.
      const current = state?.mode === target && state.pluginEnabled && hostBlockedToolsMatch(state, blocked)
        && (pipeline !== "v2" || state.gateIdentity);
      const proven = state && current
        ? effectiveHostPolicy(state, pipeline, blocked)
        : await applyHostApprovalPolicyWithClient(client, bot.profile, bot.permission_mode, pipeline, blocked);
      await db`
        update bots
           set approval_policy_mode = ${proven.mode},
               approval_policy_effective_at = case when ${proven.effective} then now() else null end
         where organization_id = ${bot.organization_id} and id = ${bot.bot_id}
      `;
      return true;
      });
      if (!handled) {
        failuresByBot.delete(key);
        continue;
      }
      failuresByBot.delete(key);
    } catch (error) {
      const attempt = recordFailure(key, now());
      const cause = error instanceof HermesClientError
        ? { code: error.code, status: error.status }
        : { code: null, status: null };
      try {
        await db`
          update bots set approval_policy_mode = null, approval_policy_effective_at = null
           where organization_id = ${bot.organization_id} and id = ${bot.bot_id}
        `;
      } finally {
        console.info(JSON.stringify({
          event: "worker.approval_policy_reconcile_failed",
          botId: bot.bot_id,
          organizationId: bot.organization_id,
          ...cause,
          attempt,
        }));
      }
    }
  }
}
