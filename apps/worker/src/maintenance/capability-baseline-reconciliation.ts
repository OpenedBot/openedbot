import type { SQL } from "bun";
import { HermesClientError, PROFILE_TOOLSETS_BATCH_FEATURE, type HermesProfileInventory } from "@openedbot/hermes";
import type { BotPermissionMode } from "@openedbot/contracts-api";
import {
  BASELINE_REQUIRED_FEATURES,
  CAPABILITY_BASELINE_VERSION,
  baselineEnabledToolsets,
  baselineGate,
  baselineToolsetPlan,
} from "@openedbot/roster/domain/capability-baseline";
import { createRuntimeClient } from "@openedbot/execution/application/runtime-client";
import { withBotProfileLock } from "@openedbot/portability/application/profile-import-guard";
import type { Db } from "@openedbot/platform-db";
import { pgTextArray } from "@openedbot/platform-db/text-array";
import type { WorkerConfig } from "../config";

const BATCH_SIZE = 50;
const BASELINE_RETRY_BASE_MS = 30_000;
const BASELINE_RETRY_MAX_MS = 15 * 60_000;
/**
 * A host that accepts the writes but never reads back the baseline is not
 * transient: after this many such failures in a row the bot is reported
 * stuck once and retried every `BASELINE_STUCK_RETRY_MS` only.
 */
const BASELINE_STUCK_AFTER = 5;
const BASELINE_STUCK_RETRY_MS = 6 * 60 * 60_000;
let cursor: { organizationId: string; botId: string } | null = null;
const failuresByBot = new Map<string, { failures: number; unverified: number; nextAttemptAt: number }>();

function recordFailure(key: string, nowMs: number, unverified = false): { failures: number; stuck: boolean; reported: boolean } {
  const previous = failuresByBot.get(key);
  const failures = (previous?.failures ?? 0) + 1;
  const unverifiedInRow = unverified ? (previous?.unverified ?? 0) + 1 : 0;
  const stuck = unverifiedInRow >= BASELINE_STUCK_AFTER;
  const delay = stuck
    ? BASELINE_STUCK_RETRY_MS
    : Math.min(BASELINE_RETRY_MAX_MS, BASELINE_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 5));
  failuresByBot.set(key, { failures, unverified: unverifiedInRow, nextAttemptAt: nowMs + delay });
  return { failures, stuck, reported: unverifiedInRow === BASELINE_STUCK_AFTER };
}

function unverified(message: string): HermesClientError {
  return new HermesClientError(message, 502, "PROFILE_UNVERIFIED");
}

type BaselineClient = Pick<ReturnType<typeof createRuntimeClient>, "toolsets">;
type BaselineApplyClient = Pick<ReturnType<typeof createRuntimeClient>,
  "toolsets" | "probeProfileIsolation" | "hostSetProfileToolset" | "hostSetProfileToolsets" | "hostSetProfileBundledSkills">;

/**
 * Les toolsets du profil, lus sur le gateway qui le sert (`/p/<slug>/v1/toolsets`,
 * le client est celui du profil) : la vue sur laquelle l'hôte prouve chaque
 * écriture, et celle que voient les runs. L'inventaire de tous les profils
 * (`hostProfileInventory`) repartait d'un interpréteur froid après chaque
 * écriture de profil, ~1 s par lecture au provisionnement (VM 240, 2026-11-02).
 * Un profil que le gateway ne sert pas est un échec, jamais un socle vide.
 */
async function profileToolsets(client: BaselineClient, profile: string): Promise<Array<{ name: string; enabled: boolean }>> {
  const toolsets = await client.toolsets();
  if (toolsets === null) throw new HermesClientError(`The gateway does not serve the bot profile ${profile}.`, 404, "PROFILE_NOT_FOUND");
  return toolsets;
}

/**
 * Socle « bot léger » : amène chaque bot à profil géré dont la
 * version stockée est sous `CAPABILITY_BASELINE_VERSION` au socle (toolsets
 * du profil, skills livrées avec Hermes), puis estampille la version. Un
 * bot neuf part à 0 et passe ici dès que sa provision a réussi. Un échec
 * laisse la version telle quelle : la passe suivante recommence, après un
 * recul exponentiel par bot.
 */
export async function reconcileCapabilityBaselines(
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
    host_holds_policy: boolean;
    toolsets_batch: boolean;
  }>>`
    select b.id as bot_id, b.organization_id, rt.id as runtime_id, b.hermes_profile as profile,
           rt.link_features @> array['approval_policy']::text[] as host_holds_policy,
           rt.link_features @> array[${PROFILE_TOOLSETS_BATCH_FEATURE}]::text[] as toolsets_batch
      from bots b
      join runtimes rt on rt.organization_id = b.organization_id and rt.is_active and rt.revoked_at is null
     where b.hermes_profile_managed
       and b.hermes_profile is not null
       and b.deleted_at is null
       and b.capability_baseline_version < ${CAPABILITY_BASELINE_VERSION}
       and rt.reachability = 'connector'
       and rt.link_features @> ${pgTextArray(BASELINE_REQUIRED_FEATURES)}::text[]
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
  // Ce que l'hôte accepte d'écrire : un nom hors liste (`bfl` sous Hermes
  // 0.22.2) serait refusé et bloquerait le socle du bot pour toujours.
  const settableByRuntime = new Map<string, Promise<ReadonlySet<string>>>();
  for (const bot of bots) {
    if (signal?.aborted) return;
    cursor = { organizationId: bot.organization_id, botId: bot.bot_id };
    const key = `${bot.organization_id}:${bot.bot_id}`;
    if ((failuresByBot.get(key)?.nextAttemptAt ?? 0) > now()) continue;
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
      let settablePromise = settableByRuntime.get(bot.runtime_id);
      if (!settablePromise) {
        settablePromise = client.hostToolsets().then((toolsets) => new Set(toolsets.settable));
        settableByRuntime.set(bot.runtime_id, settablePromise);
      }
      const settable = await settablePromise;
      const row = inventory.profiles.find((profile) => profile.name === bot.profile);
      if (!row) {
        recordFailure(key, now());
        console.info(JSON.stringify({
          event: "worker.capability_baseline_profile_missing",
          botId: bot.bot_id,
          organizationId: bot.organization_id,
          profile: bot.profile,
        }));
        continue;
      }
      // Même verrou que `updateBot` et la provision : la version est relue sous
      // le verrou, une passe concurrente ou un import ne se marchent pas dessus.
      const applied = await lockProfile(bot.organization_id, bot.bot_id, () => applyCapabilityBaseline(db, client, {
        organizationId: bot.organization_id,
        botId: bot.bot_id,
        profile: bot.profile,
        hostHoldsPolicy: bot.host_holds_policy === true,
        toolsetsBatch: bot.toolsets_batch === true,
      }, settable, now));
      if (applied?.pending) {
        // Not a failure: the approval policy reconciliation proves the gate,
        // this pass comes back on the usual backoff.
        recordFailure(key, now());
        console.info(JSON.stringify({
          event: "worker.capability_baseline_waiting_policy",
          botId: bot.bot_id,
          organizationId: bot.organization_id,
        }));
        continue;
      }
      failuresByBot.delete(key);
      if (!applied) continue;
      console.info(JSON.stringify({
        event: "worker.capability_baseline_applied",
        botId: bot.bot_id,
        organizationId: bot.organization_id,
        profile: bot.profile,
        gate: applied.gate,
        isolated: applied.isolated,
        toolsetWrites: applied.writes,
        unavailable: applied.unavailable,
        additive: applied.additive,
        bundled: applied.bundled,
        version: CAPABILITY_BASELINE_VERSION,
      }));
    } catch (error) {
      const cause = error instanceof HermesClientError
        ? { code: error.code, status: error.status }
        : { code: null, status: null };
      const outcome = recordFailure(key, now(), cause.code === "PROFILE_UNVERIFIED");
      console.info(JSON.stringify({
        event: outcome.reported ? "worker.capability_baseline_stuck" : "worker.capability_baseline_failed",
        botId: bot.bot_id,
        organizationId: bot.organization_id,
        ...cause,
        attempt: outcome.failures,
        stuck: outcome.stuck,
      }));
    }
  }
}

export type BaselineTarget = {
  organizationId: string;
  botId: string;
  profile: string;
  hostHoldsPolicy: boolean;
  /** L'hôte annonce `profile_toolsets_batch` : les écritures du socle partent en un lot. */
  toolsetsBatch?: boolean;
  /**
   * La création du profil a déjà éteint les skills livrées, preuve de l'hôte
   * à l'appui (`bundledSkills` de la réponse) : le socle ne les réécrit pas.
   */
  bundledSkillsOff?: boolean;
  /** Les toolsets que le socle va activer, annoncés avant ses écritures (écran d'attente, 0164). */
  onTools?(names: readonly string[]): Promise<void>;
};

export type BaselineOutcome =
  | null
  | { pending: true }
  | {
    pending: false;
    gate: "gated" | "ungated";
    isolated: boolean;
    writes: ReturnType<typeof baselineToolsetPlan>["writes"];
    unavailable: string[];
    additive: boolean;
    bundled: number | null;
  };

/**
 * One bot's baseline, under the caller's profile lock: `null` when it is
 * already at the version, `pending` while its gate is unproven. Shared by the
 * reconciliation pass and the provisioning, which applies it before a new bot
 * is served so its first turns see their final tool list (a later change of
 * that list misses the prompt cache).
 */
export async function applyCapabilityBaseline(
  db: SQL,
  client: BaselineApplyClient,
  bot: BaselineTarget,
  settable: ReadonlySet<string>,
  now: () => number,
): Promise<BaselineOutcome> {
  const fresh = await db<Array<{
    capability_baseline_version: number;
    permission_mode: BotPermissionMode;
    permission_pipeline: string;
    approval_policy_mode: string | null;
    approval_policy_effective_at: Date | null;
  }>>`
    select b.capability_baseline_version, b.permission_mode, o.permission_pipeline,
           b.approval_policy_mode, b.approval_policy_effective_at
      from bots b
      join organizations o on o.id = b.organization_id
     where b.organization_id = ${bot.organizationId} and b.id = ${bot.botId} and b.deleted_at is null
  `;
  const current = fresh[0];
  if (!current || current.capability_baseline_version >= CAPABILITY_BASELINE_VERSION) return null;
  // File, code and browser open only where a gate is proven to answer
  // their writes; a mode that wants no host gate keeps the light set.
  const gate = baselineGate({
    hostHoldsPolicy: bot.hostHoldsPolicy,
    permissionMode: current.permission_mode,
    pipeline: current.permission_pipeline,
    approvalPolicyMode: current.approval_policy_mode,
    approvalPolicyEffectiveAt: current.approval_policy_effective_at,
  }, now());
  if (gate === "pending") return { pending: true as const };
  // L'inventaire de la passe a pu vieillir avant le verrou (une bascule
  // faite entre-temps) : les écritures partent d'une relecture fraîche.
  // The profile-only stores open on a proven isolation only.
  const isolated = await client.probeProfileIsolation(bot.profile).then((state) => state === "isolated", () => false);
  const enabledSet = baselineEnabledToolsets({ gated: gate === "gated", isolated });
  // A bot already stamped once gets the replay additively: a toolset of
  // the set that is off is turned back on, and what the operator turned
  // on beyond the set stays, skills included.
  const additive = current.capability_baseline_version >= 1;
  const plan = baselineToolsetPlan(await profileToolsets(client, bot.profile), settable, enabledSet, { isolated, additive });
  if (plan.required.length) {
    throw new HermesClientError("The host cannot set a toolset the capability baseline requires.", 409, "TOOLSET_NOT_SETTABLE");
  }
  await bot.onTools?.(enabledSet.filter((name) => settable.has(name)));
  // En lot quand l'hôte le sait : un appel CLI par sens au lieu d'un par
  // toolset, l'essentiel du temps de provision d'un bot neuf. Chaque nom
  // garde sa propre vérification.
  if (bot.toolsetsBatch && plan.writes.length > 0) {
    const states = await client.hostSetProfileToolsets(bot.profile, Object.fromEntries(plan.writes.map((write) => [write.name, write.enabled])));
    for (const write of plan.writes) {
      if (states.find((state) => state.name === write.name)?.enabled !== write.enabled) {
        throw unverified("The capability baseline toolset write could not be verified.");
      }
    }
  } else {
    for (const write of plan.writes) {
      const state = await client.hostSetProfileToolset(bot.profile, write.name, write.enabled);
      if (state.enabled !== write.enabled) throw unverified("The capability baseline toolset write could not be verified.");
    }
  }
  const bundled = additive || bot.bundledSkillsOff ? null : await client.hostSetProfileBundledSkills(bot.profile, false);
  if (bundled && !bundled.applied) throw unverified("The capability baseline bundled skills write could not be verified.");
  // La version n'est posée que sur un profil relu au socle, pas sur la
  // somme des réponses individuelles.
  if (baselineToolsetPlan(await profileToolsets(client, bot.profile), settable, enabledSet, { isolated, additive }).writes.length > 0) {
    throw unverified("The capability baseline was not found on the profile after its writes.");
  }
  // The stores were opened on an isolation proven before the writes: it
  // must still hold at the stamp, or the next pass turns them off.
  if (isolated && (await client.probeProfileIsolation(bot.profile).catch(() => null)) !== "isolated") {
    throw unverified("The profile isolation no longer holds after the capability baseline writes.");
  }
  await db`
    update bots set capability_baseline_version = ${CAPABILITY_BASELINE_VERSION}
     where organization_id = ${bot.organizationId} and id = ${bot.botId}
  `;
  return { pending: false as const, gate, isolated, writes: plan.writes, unavailable: plan.unavailable, additive, bundled: bundled?.bundled ?? null };
}

/**
 * The baseline of a bot whose profile the provisioning has just proven and
 * served (`ProfileProvisionDependencies.baseline`), on the same terms as the
 * reconciliation pass: a connector runtime that announces the baseline verbs,
 * a managed profile, the profile lock. The pass skips a bot while its
 * provision runs, so the two never write the same profile at once.
 *
 * `prefetched.settable`: the host's settable toolsets, read at the start of
 * the pass. Creating the profile dropped the operator's read cache, so the
 * same read made here cost 3.5 s cold against 13 ms warm (VM 240,
 * 2026-11-02). What a host can set does not depend on the new profile. `null`
 * (failed read) falls back on a read here. `prefetched.bundledSkillsOff`: the
 * creation proved the bundled skills off (BaselineTarget).
 */
export async function provisionCapabilityBaseline(
  db: SQL,
  config: WorkerConfig,
  job: { organization_id: string; bot_id: string; runtime_id: string },
  clientFactory: typeof createRuntimeClient = createRuntimeClient,
  lockProfile: <T>(organizationId: string, botId: string, run: () => Promise<T>) => Promise<T> =
    (organizationId, botId, run) => withBotProfileLock(db as unknown as Db, organizationId, botId, () => run()),
  now: () => number = Date.now,
  prefetched: { settable?: Promise<ReadonlySet<string> | null>; bundledSkillsOff?: boolean; onTools?: BaselineTarget["onTools"] } = {},
): Promise<"applied" | "current" | "pending" | "unsupported"> {
  const rows = await db<Array<{ profile: string; host_holds_policy: boolean; toolsets_batch: boolean }>>`
    select b.hermes_profile as profile,
           rt.link_features @> array['approval_policy']::text[] as host_holds_policy,
           rt.link_features @> array[${PROFILE_TOOLSETS_BATCH_FEATURE}]::text[] as toolsets_batch
      from bots b
      join runtimes rt on rt.organization_id = b.organization_id and rt.id = ${job.runtime_id}
                      and rt.is_active and rt.revoked_at is null
     where b.organization_id = ${job.organization_id} and b.id = ${job.bot_id}
       and b.hermes_profile_managed
       and b.hermes_profile is not null
       and b.deleted_at is null
       and rt.reachability = 'connector'
       and rt.link_features @> ${pgTextArray(BASELINE_REQUIRED_FEATURES)}::text[]
  `;
  const bot = rows[0];
  if (!bot) return "unsupported";
  const client = clientFactory({
    runtimeId: job.runtime_id,
    reachability: "connector",
    runtimeEndpoint: null,
    tokenCiphertext: null,
    tokenNonce: null,
    tokenTag: null,
    tokenKeyId: null,
    hermesProfile: bot.profile,
  }, config);
  const settable = (await prefetched.settable) ?? new Set((await client.hostToolsets()).settable);
  const applied = await lockProfile(job.organization_id, job.bot_id, () => applyCapabilityBaseline(db, client, {
    organizationId: job.organization_id,
    botId: job.bot_id,
    profile: bot.profile,
    hostHoldsPolicy: bot.host_holds_policy === true,
    toolsetsBatch: bot.toolsets_batch === true,
    bundledSkillsOff: prefetched.bundledSkillsOff === true,
    onTools: prefetched.onTools,
  }, settable, now));
  if (!applied) return "current";
  if (applied.pending) return "pending";
  console.info(JSON.stringify({
    event: "worker.capability_baseline_applied",
    botId: job.bot_id,
    organizationId: job.organization_id,
    profile: bot.profile,
    gate: applied.gate,
    isolated: applied.isolated,
    toolsetWrites: applied.writes,
    unavailable: applied.unavailable,
    additive: applied.additive,
    bundled: applied.bundled,
    version: CAPABILITY_BASELINE_VERSION,
    during: "provision",
  }));
  return "applied";
}
