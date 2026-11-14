import { randomBytes } from "node:crypto";
import { HermesClientError, type HermesClient, type HermesClientConfig } from "@openedbot/hermes";
import type { BotRoutineToolDto, BotRoutineToolReason } from "@openedbot/contracts-api";
import {
  RELAY_FEATURE_GATEWAY_RESTART,
  RELAY_FEATURE_MCP_LIVE_RELOAD,
  RELAY_FEATURE_MCP_MANAGEMENT,
  RELAY_FEATURE_PROFILE_CAPABILITIES,
} from "@openedbot/contracts-connector/features";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { ROUTINE_TOOL_NAME, ROUTINE_TOOL_SERVER } from "@openedbot/execution/domain/routine-tool";
import {
  readRoutineToolBots,
  readRoutineToolServer,
  type RoutineToolServerState,
} from "@openedbot/execution/application/routine-tool-state";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { logEvent } from "@openedbot/platform-observability";
import { assertProfileNamesAvailable } from "@openedbot/roster/application/profile-import-guard";
import { runtimeAdminClient } from "@openedbot/runtimes/application/runtime-admin-client";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";
import type { ApiConfig } from "../../infrastructure/config";
import { routineToolSecretHash } from "./routine-tool-routes";
import { withTryLock } from "./routine-tool-session";
import { profileReady, routineToolStatus, routineToolUsesDevelopmentCallback, type RoutineToolBotRow } from "./routine-tool-status";

export { routineToolStatus, routineToolUsesDevelopmentCallback, withRoutineToolReconcile, type RoutineToolBotRow } from "./routine-tool-status";

/**
 * `routine_manage` on by default (0187): the API installs the tool on every
 * bot of an organization whose host can carry it, and keeps it so.
 *
 * Triggers, all in the API, which holds the public URL and the secret:
 *   - the host's `inventory.changed` signal, sent once per link session and
 *     whenever its profiles' files move (a reconnecting host, a bot whose
 *     profile the worker just created), `withRoutineToolReconcile`;
 *   - a sweep every minute over the organizations with work due
 *     (`routine_tool_due_organizations`): backoffs, pending restarts, the
 *     periodic verification of the host, any replica;
 *   - the operator's switch, which records the choice and schedules a pass.
 *
 * A pass holds a lock of its own per organization, taken with a try-lock
 * (installer against installer, across replicas: ONE root secret), never the
 * organization's profile lock across host calls. Each profile write takes
 * that shared lock alone, with a try-lock too, and rereads the bot under it:
 * a profile being created, imported or deleted is never written to, and
 * bot creation never waits behind a slow host for more than one write.
 *
 * Nothing here restarts a gateway: a host without MCP live reload leaves the
 * tool `restart_pending` until the operator restarts it, and runs are told so.
 */

export type RoutineToolInstallClient = Pick<
  HermesClient,
  "hostCapabilities" | "mcpInventory" | "mcpServerAdd" | "hostSetProfileMcpServer" | "gatewayStatus" | "hostProfileInventory"
>;

export type RoutineToolInstallerDeps = {
  readRuntime?: typeof readRuntimeSecret;
  clientFactory?: (clientConfig: HermesClientConfig) => RoutineToolInstallClient;
};

type Block = BotRoutineToolReason;
type Runtime = NonNullable<Awaited<ReturnType<typeof readRuntimeSecret>>>;
type Host =
  | { block: Block; runtime: Runtime | null; client: null; features: readonly string[] }
  | { block: null; runtime: Runtime; client: RoutineToolInstallClient; features: readonly string[] };


/** One gateway MCP reload tick (about a minute, upstream) plus margin. */
export const ROUTINE_TOOL_SETTLE_SECONDS = 90;
/** Background passes at once in a process: each holds a pooled connection for its lock. */
export const ROUTINE_TOOL_PARALLEL_PASSES = 2;
/** Host writes in one pass, and its wall time: the rest waits for the next pass. */
export const ROUTINE_TOOL_PASS_WRITES = 8;
export const ROUTINE_TOOL_PASS_BUDGET_MS = 60_000;
/** Root writes the host could not confirm before automatic root retries stop for this link session. */
export const ROUTINE_TOOL_ROOT_FAILURES_MAX = 3;
const SWEEP_EVERY_MS = 60_000;
const SWEEP_ORGANIZATIONS = 20;
const INSTALLER_LOCK = "routine-tool-install";
/** The organization's profile lock (imports, baselines, bot updates): taken per profile write only. */
const PROFILE_LOCK = "hermes-profile-import";

class InstallFailure extends Error {
  constructor(readonly reason: Block) {
    super(reason);
  }
}

export type RoutineToolInstaller = ReturnType<typeof createRoutineToolInstaller>;
type Hold = { kind: "none" } | { kind: "backoff" } | { kind: "until"; seconds: number };

export function createRoutineToolInstaller(db: Db, config: ApiConfig, deps: RoutineToolInstallerDeps = {}) {
  const readRuntime = deps.readRuntime ?? readRuntimeSecret;
  const clientFactory = deps.clientFactory ?? runtimeAdminClient;
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const waiting = new Set<string>();

  const tenant = <T>(conn: Db, organizationId: string, run: (tx: TransactionDb) => Promise<T>) => withTenant(conn, organizationId, run);
  const readBots = (conn: Db, organizationId: string, botId: string | null) =>
    tenant(conn, organizationId, (tx) => readRoutineToolBots(tx, organizationId, botId)) as Promise<RoutineToolBotRow[]>;

  async function resolveHost(conn: Db, organizationId: string): Promise<Host> {
    // Development uses the host's enrolled SSH loopback tunnel. Production
    // still requires HTTPS; no HTTP origin supplied by a browser is trusted.
    const development = routineToolUsesDevelopmentCallback(config);
    if (!config.publicUrl.startsWith("https://") && !development) return { block: "https_required", runtime: null, client: null, features: [] };
    let runtime: Runtime | null;
    try {
      runtime = await readRuntime(conn, config, organizationId);
    } catch (error) {
      if (error instanceof HttpError && error.code === "RUNTIME_LINK_UNAVAILABLE") return { block: "host_offline", runtime: null, client: null, features: [] };
      throw error;
    }
    if (!runtime) return { block: "runtime_required", runtime: null, client: null, features: [] };
    const client = clientFactory(runtime.client);
    let features: string[] | null;
    try {
      features = await client.hostCapabilities();
    } catch (error) {
      if (error instanceof HermesClientError) return { block: "host_offline", runtime, client: null, features: [] };
      throw error;
    }
    const known = features ?? [];
    const unsupported = !known.includes(RELAY_FEATURE_MCP_MANAGEMENT)
      || (development && !known.includes("mcp_development_callbacks"))
      // Without either, nothing would ever tell openedbot when runs see the tool.
      || (!known.includes(RELAY_FEATURE_MCP_LIVE_RELOAD) && !known.includes(RELAY_FEATURE_GATEWAY_RESTART));
    if (unsupported) return { block: "host_unsupported", runtime, client: null, features: known };
    return { block: null, runtime, client, features: known };
  }

  const ensureRows = async (tx: TransactionDb, organizationId: string, botIds: readonly string[]) => {
    for (const botId of botIds) {
      await tx`insert into bot_routine_tools (organization_id, bot_id) values (${organizationId}, ${botId}) on conflict do nothing`;
    }
  };

  async function recordProof(conn: Db, organizationId: string, botId: string, runtimeId: string, proof: { enabled: true; live: boolean } | { enabled: false }): Promise<void> {
    await tenant(conn, organizationId, async (tx) => {
      await ensureRows(tx, organizationId, [botId]);
      await tx`
        update bot_routine_tools
           set runtime_id = ${runtimeId},
               enabled_at = case when ${proof.enabled} then now() else null end,
               disabled_at = case when ${proof.enabled} then null else now() end,
               ready_at = case when ${proof.enabled && proof.live} then now() + (${ROUTINE_TOOL_SETTLE_SECONDS} * interval '1 second') else null end,
               restart_pending_since = case when ${proof.enabled && !proof.live} then now() else null end,
               blocked_reason = null, attempts = 0, next_attempt_at = null, updated_at = now()
         where organization_id = ${organizationId} and bot_id = ${botId}
      `;
    });
    logEvent(proof.enabled ? "routine_tool.enabled" : "routine_tool.disabled", { organizationId, botId, ...(proof.enabled ? { live: proof.live } : {}) });
  }

  /**
   * Why a bot does not have the tool, and when the sweep looks again:
   * `backoff` after a failed host write (1 min, doubling, 6 h at most),
   * `until` a fixed delay for a reason that does not cost a write.
   */
  async function recordBlocked(conn: Db, organizationId: string, botIds: readonly string[], reason: Block, hold: Hold): Promise<void> {
    if (!botIds.length) return;
    const backoff = hold.kind === "backoff";
    const seconds = hold.kind === "until" ? hold.seconds : null;
    await tenant(conn, organizationId, async (tx) => {
      await ensureRows(tx, organizationId, botIds);
      await tx`
        update bot_routine_tools
           set blocked_reason = ${reason},
               attempts = case when ${backoff} then attempts + 1 else attempts end,
               next_attempt_at = case
                 when ${backoff} then now() + least(interval '6 hours', interval '1 minute' * power(2, least(attempts, 9)))
                 when ${seconds}::integer is not null then now() + (${seconds}::integer * interval '1 second')
                 else null end,
               updated_at = now()
         where organization_id = ${organizationId} and bot_id = any(${botIds}::uuid[])
      `;
    });
    logEvent("routine_tool.blocked", { organizationId, bots: botIds.length, reason, hold: hold.kind });
  }

  /** The proof no longer holds (new secret, drift, retired profile): the bot is proven again. */
  async function clearProofs(conn: Db, organizationId: string, botIds: readonly string[]): Promise<void> {
    if (!botIds.length) return;
    await tenant(conn, organizationId, (tx) => tx`
      update bot_routine_tools
         set runtime_id = null, enabled_at = null, disabled_at = null, ready_at = null,
             restart_pending_since = null, updated_at = now()
       where organization_id = ${organizationId} and bot_id = any(${botIds}::uuid[])
    `);
  }

  /**
   * Lifts `restart_pending` only on the host's own word that no restart is
   * waiting (`restartPending === false`), for the writes recorded before the
   * read: no comparison of the database clock with the host's. A wait that
   * goes on is looked at again later, doubling, 6 h at most.
   */
  async function settleRestart(conn: Db, organizationId: string, client: RoutineToolInstallClient): Promise<void> {
    const before = (await conn<Array<{ at: Date }>>`select now() as at`)[0]!.at;
    let pending: boolean;
    try {
      pending = (await client.gatewayStatus()).restartPending;
    } catch (error) {
      if (error instanceof HermesClientError) return;
      throw error;
    }
    await tenant(conn, organizationId, (tx) => pending
      ? tx`
          update bot_routine_tools
             set attempts = attempts + 1, updated_at = now(),
                 next_attempt_at = now() + least(interval '6 hours', interval '10 minutes' * power(2, least(attempts, 6)))
           where organization_id = ${organizationId} and restart_pending_since is not null
             and (next_attempt_at is null or next_attempt_at <= now())`
      : tx`
          update bot_routine_tools
             set restart_pending_since = null, ready_at = now(), attempts = 0, next_attempt_at = null, updated_at = now()
           where organization_id = ${organizationId} and restart_pending_since is not null
             and restart_pending_since <= ${before}`);
  }

  /**
   * The root server, one per runtime. `false` when it is in place and was
   * confirmed with the stored secret (the common case: no write). Otherwise a
   * NEW secret, the old one known to nobody: `onMint` runs once it replaced
   * the old one in the database, before the host write.
   */
  async function ensureServer(conn: Db, client: RoutineToolInstallClient, runtimeId: string, organizationId: string, server: RoutineToolServerState, onMint: () => void): Promise<boolean> {
    const inventory = await client.mcpInventory();
    const present = inventory.servers.find((entry) => entry.name === ROUTINE_TOOL_SERVER);
    if (server.installed && present?.configEnabled) return false;
    const secret = randomBytes(32).toString("base64url");
    await tenant(conn, organizationId, (tx) => tx`
      insert into runtime_routine_tools (organization_id, runtime_id, secret_hash, server_name, created_by_user_id)
      values (${organizationId}, ${runtimeId}, ${routineToolSecretHash(secret)}, ${ROUTINE_TOOL_SERVER}, ${null})
      on conflict (organization_id, runtime_id) do update
        set secret_hash = excluded.secret_hash, installed_at = null, updated_at = now()
    `);
    onMint();
    const added = await client.mcpServerAdd({
      name: ROUTINE_TOOL_SERVER,
      url: routineToolUsesDevelopmentCallback(config)
        ? `openedbot-dev://${runtimeId}/api/mcp/routines/${organizationId}`
        : `${config.publicUrl.replace(/\/+$/, "")}/api/mcp/routines/${organizationId}`,
      auth: "header",
      token: secret,
      replace: true,
    });
    // The host probes the server on add: if it could not reach the API, it
    // records it disabled, and no run would see the tool.
    if (added.unreachable || !added.discoveredTools?.includes(ROUTINE_TOOL_NAME)) throw new InstallFailure("host_unreachable");
    const reread = await client.mcpInventory();
    if (!reread.servers.some((entry) => entry.name === ROUTINE_TOOL_SERVER && entry.configEnabled)) throw new InstallFailure("unverified");
    await tenant(conn, organizationId, (tx) => tx`
      update runtime_routine_tools set installed_at = now(), root_failures = 0, root_failed_link_at = null, updated_at = now()
       where organization_id = ${organizationId} and runtime_id = ${runtimeId}
    `);
    return true;
  }

  function failureReason(error: unknown): Block {
    if (error instanceof InstallFailure) return error.reason;
    if (error instanceof HermesClientError) return error.code === "HERMES_UNREACHABLE" ? "host_offline" : "unverified";
    if (error instanceof HttpError && error.code === "RUNTIME_LINK_UNAVAILABLE") return "host_offline";
    throw error;
  }

  /**
   * The read-only check of what the host says, every 30 minutes or after a
   * refused bearer: a profile whose entry no longer matches its proof (switched
   * by hand, restored, recreated) loses the proof and is written again by this
   * pass. A token copy that went out of step is invisible here: the
   * operator's switch, off then on, writes it again.
   */
  async function verify(conn: Db, organizationId: string, runtimeId: string, client: RoutineToolInstallClient, bots: RoutineToolBotRow[]): Promise<void> {
    let profiles: Awaited<ReturnType<RoutineToolInstallClient["hostProfileInventory"]>>["profiles"];
    try {
      profiles = (await client.hostProfileInventory()).profiles;
    } catch (error) {
      if (error instanceof HermesClientError) return;
      throw error;
    }
    const drifted = bots.filter((bot) => {
      if (!bot.profile || bot.runtimeId !== runtimeId || (!bot.enabledAt && !bot.disabledAt)) return false;
      const profile = profiles.find((entry) => entry.name === bot.profile);
      if (!profile) return true;
      const entry = profile.mcpServers.find((server) => server.name === ROUTINE_TOOL_SERVER);
      return bot.enabledAt ? entry?.enabled !== true : entry?.enabled === true;
    });
    await clearProofs(conn, organizationId, drifted.map((bot) => bot.id));
    if (drifted.length) logEvent("routine_tool.drift", { organizationId, bots: drifted.length });
    await tenant(conn, organizationId, (tx) => tx`
      update runtime_routine_tools set verified_at = now(), updated_at = now()
       where organization_id = ${organizationId} and runtime_id = ${runtimeId}
    `);
  }

  /**
   * One profile write under the organization's profile lock, taken without
   * waiting, after rereading the bot under it. `skipped`: the lock is busy or
   * the bot's profile is no longer writable; the sweep comes back.
   */
  async function writeProfile(session: Db, organizationId: string, botId: string, write: (profile: string) => Promise<void>): Promise<"written" | "skipped"> {
    const conn = session;
    const got = await session<Array<{ got: boolean }>>`select pg_try_advisory_lock(hashtext(${organizationId}), hashtext(${PROFILE_LOCK})) as got`;
    if (!got[0]?.got) return "skipped";
    try {
      const fresh = (await readBots(conn, organizationId, botId))[0];
      if (!fresh?.profile || !profileReady(fresh)) return "skipped";
      // A profile name an import holds is never written (the check of bot updates).
      const reserved = await tenant(conn, organizationId, async (tx) => {
        try {
          await assertProfileNamesAvailable(tx, organizationId, [fresh.slug, fresh.profile!]);
          return false;
        } catch (error) {
          if (error instanceof HttpError) return true;
          throw error;
        }
      });
      if (reserved) return "skipped";
      await write(fresh.profile);
      return "written";
    } finally {
      await session`select pg_advisory_unlock(hashtext(${organizationId}), hashtext(${PROFILE_LOCK}))`;
    }
  }

  /** One pass for an organization, under the installer's lock. */
  async function reconcileLocked(session: Db, organizationId: string): Promise<void> {
    const conn = session;
    const startedAt = Date.now();
    let writes = 0;
    const budgetLeft = () => writes < ROUTINE_TOOL_PASS_WRITES && Date.now() - startedAt < ROUTINE_TOOL_PASS_BUDGET_MS;
    let bots = await readBots(conn, organizationId, null);
    // A retired bot, or one whose profile is being created again, keeps its
    // choice; its proof is void: the profile it was made on is gone.
    await clearProofs(conn, organizationId, bots.filter((bot) => !profileReady(bot) && (bot.enabledAt || bot.disabledAt)).map((bot) => bot.id));
    if (!bots.length) return;
    const host = await resolveHost(conn, organizationId);
    const isHere = (bot: RoutineToolBotRow, runtimeId: string | null) => runtimeId !== null && bot.runtimeId === runtimeId;
    const wanted = (list: RoutineToolBotRow[], runtimeId: string | null) =>
      list.filter((bot) => !bot.switchedOff && profileReady(bot) && !(bot.enabledAt && isHere(bot, runtimeId)));
    if (host.block !== null) {
      // Nothing written. Offline: the reconnection and the sweep bring it back.
      const hold: Hold = host.block === "host_offline" ? { kind: "none" } : { kind: "until", seconds: 3600 };
      await recordBlocked(conn, organizationId, wanted(bots, host.runtime?.id ?? null).filter((bot) => bot.blockedReason !== host.block).map((bot) => bot.id), host.block, hold);
      return;
    }
    const { client, runtime, features } = host;
    const live = features.includes(RELAY_FEATURE_MCP_LIVE_RELOAD);
    const server = await tenant(conn, organizationId, (tx) => readRoutineToolServer(tx, organizationId, runtime.id));
    if (features.includes(RELAY_FEATURE_GATEWAY_RESTART) && bots.some((bot) => bot.restartPendingSince && isHere(bot, runtime.id))) {
      await settleRestart(conn, organizationId, client);
    }
    const verifyDue = server.installed && (server.verifiedAt === null
      || Date.now() - server.verifiedAt.getTime() > 30 * 60_000
      || (server.authFailedAt !== null && server.authFailedAt.getTime() > server.verifiedAt.getTime()));
    if (verifyDue) await verify(conn, organizationId, runtime.id, client, bots);
    bots = await readBots(conn, organizationId, null);
    const now = Date.now();
    const due = (bot: RoutineToolBotRow) => bot.nextAttemptAt === null || bot.nextAttemptAt.getTime() <= now;
    let toEnable = wanted(bots, runtime.id).filter(due);
    const toDisable = bots.filter((bot) => bot.switchedOff && bot.profile && profileReady(bot) && !(bot.disabledAt && isHere(bot, runtime.id)) && due(bot));
    const enabledHere = bots.filter((bot) => bot.enabledAt && isHere(bot, runtime.id));

    if (toEnable.length || enabledHere.length) {
      const paused = server.rootFailures >= ROUTINE_TOOL_ROOT_FAILURES_MAX
        && server.rootFailedLinkAt !== null && server.linkConnectedAt !== null
        && server.rootFailedLinkAt.getTime() === server.linkConnectedAt.getTime();
      let minted = false;
      try {
        // A paused root is still read: only its rewrite waits.
        if (paused && !(server.installed && (await client.mcpInventory()).servers.some((entry) => entry.name === ROUTINE_TOOL_SERVER && entry.configEnabled))) {
          await recordBlocked(conn, organizationId, toEnable.map((bot) => bot.id), "host_unreachable", { kind: "until", seconds: 6 * 3600 });
          return;
        }
        writes += 1;
        if (await ensureServer(conn, client, runtime.id, organizationId, server, () => { minted = true; })) {
          // The host copies the token into a profile when it enables the server
          // there: after a new secret, EVERY bot proven on the old one holds the
          // old token and is written again, whatever started this pass.
          const stale = enabledHere.filter((bot) => !bot.switchedOff);
          await clearProofs(conn, organizationId, stale.map((bot) => bot.id));
          toEnable = [...toEnable, ...stale.filter((bot) => !toEnable.includes(bot))];
        } else {
          writes -= 1;
        }
      } catch (error) {
        const reason = failureReason(error);
        const stale = minted ? enabledHere.filter((bot) => !bot.switchedOff) : [];
        await clearProofs(conn, organizationId, stale.map((bot) => bot.id));
        await recordBlocked(conn, organizationId, [...toEnable, ...stale].map((bot) => bot.id), reason, { kind: "backoff" });
        if (minted) {
          await tenant(conn, organizationId, (tx) => tx`
            update runtime_routine_tools
               set root_failures = root_failures + 1, root_failed_link_at = ${server.linkConnectedAt}, updated_at = now()
             where organization_id = ${organizationId} and runtime_id = ${runtime.id}
          `);
        }
        logEvent("routine_tool.server_failed", { organizationId, reason, rootFailures: server.rootFailures + (minted ? 1 : 0) });
        return;
      }
    }
    for (const bot of toDisable) {
      if (!budgetLeft()) break;
      try {
        writes += 1;
        const outcome = await writeProfile(session, organizationId, bot.id, async (profile) => {
          try {
            const state = await client.hostSetProfileMcpServer(profile, ROUTINE_TOOL_SERVER, false);
            if (state.applied === false) throw new InstallFailure("unverified");
          } catch (error) {
            // Neither the profile nor the root has the entry: nothing to switch off.
            if (!(error instanceof HermesClientError && error.code === "MCP_SERVER_NOT_FOUND")) throw error;
          }
        });
        if (outcome === "written") await recordProof(conn, organizationId, bot.id, runtime.id, { enabled: false });
      } catch (error) {
        await recordBlocked(conn, organizationId, [bot.id], failureReason(error), { kind: "backoff" });
      }
    }
    for (const bot of toEnable) {
      if (bot.profile && !features.includes(RELAY_FEATURE_PROFILE_CAPABILITIES)) {
        if (bot.blockedReason !== "profile_unsupported") await recordBlocked(conn, organizationId, [bot.id], "profile_unsupported", { kind: "until", seconds: 3600 });
        continue;
      }
      if (!budgetLeft()) break;
      try {
        if (bot.profile) {
          writes += 1;
          // An entry the profile inherited from the root proves nothing (no
          // token copy): the server is always written through the host.
          const outcome = await writeProfile(session, organizationId, bot.id, async (profile) => {
            const state = await client.hostSetProfileMcpServer(profile, ROUTINE_TOOL_SERVER, true);
            if (!state.applied) throw new InstallFailure("unverified");
          });
          if (outcome === "skipped") continue;
        }
        await recordProof(conn, organizationId, bot.id, runtime.id, { enabled: true, live });
      } catch (error) {
        await recordBlocked(conn, organizationId, [bot.id], failureReason(error), { kind: "backoff" });
      }
    }
  }

  /** One pass; `busy` when another pass of this organization holds the installer's lock. */
  async function reconcileNow(organizationId: string): Promise<"done" | "busy"> {
    const done = await withTryLock(db, organizationId, INSTALLER_LOCK, async (session) => {
      await reconcileLocked(session, organizationId);
      return true;
    });
    return done ? "done" : "busy";
  }

  /**
   * A background pass for an organization: one at a time per organization and
   * `ROUTINE_TOOL_PARALLEL_PASSES` in all per process, the others queued; a
   * signal received meanwhile runs ONE more pass at the end. A failure is
   * logged, never thrown: the trigger has nobody to tell, the sweep retries.
   */
  function schedule(organizationId: string): void {
    if (running.has(organizationId)) {
      again.add(organizationId);
      return;
    }
    if (running.size >= ROUTINE_TOOL_PARALLEL_PASSES) {
      waiting.add(organizationId);
      return;
    }
    const work = (async () => {
      do {
        again.delete(organizationId);
        try {
          await reconcileNow(organizationId);
        } catch (error) {
          logEvent("routine_tool.reconcile_failed", {
            organizationId,
            code: error instanceof HttpError || error instanceof HermesClientError ? error.code : "UNEXPECTED",
          }, "warn");
        }
      } while (again.has(organizationId));
    })().finally(() => {
      running.delete(organizationId);
      const next = waiting.values().next();
      if (!next.done) {
        waiting.delete(next.value);
        schedule(next.value);
      }
    });
    running.set(organizationId, work);
  }

  /** One sweep tick: the organizations with work due, from any tenant, ids only. */
  async function sweep(): Promise<number> {
    const rows = await db<Array<{ id: string }>>`select routine_tool_due_organizations(${SWEEP_ORGANIZATIONS}) as id`;
    for (const row of rows) schedule(row.id);
    return rows.length;
  }

  return {
    schedule,
    reconcileNow,
    sweep,
    /** The periodic sweep of this process; the interval never holds the process open. */
    startSweep(everyMs = SWEEP_EVERY_MS): () => void {
      const timer = setInterval(() => {
        void sweep().catch((error: unknown) => logEvent("routine_tool.sweep_failed", { error: String(error) }, "warn"));
      }, everyMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    /** Tests: waits for the passes in progress to finish. */
    async idle(): Promise<void> {
      while (running.size > 0 || waiting.size > 0) await Promise.allSettled([...running.values()]);
    },
    /**
     * The operator's switch, remembered whatever the host does. Switching it
     * on again writes the bot's profile anew (a token copy out of step is
     * repaired) and lifts a root pause: an operator acted.
     */
    async setSwitchedOff(organizationId: string, botId: string, switchedOff: boolean, userId: string): Promise<void> {
      await tenant(db, organizationId, async (tx) => {
        await tx`
          insert into bot_routine_tools (organization_id, bot_id, switched_off, decided_by_user_id, decided_at)
          values (${organizationId}, ${botId}, ${switchedOff}, ${userId}, now())
          on conflict (organization_id, bot_id) do update
            set switched_off = excluded.switched_off, decided_by_user_id = excluded.decided_by_user_id,
                decided_at = now(), attempts = 0, next_attempt_at = null, blocked_reason = null,
                runtime_id = null, enabled_at = null, disabled_at = null, ready_at = null,
                restart_pending_since = null, updated_at = now()
        `;
        if (!switchedOff) {
          await tx`
            update runtime_routine_tools set root_failures = 0, root_failed_link_at = null, updated_at = now()
             where organization_id = ${organizationId}
          `;
        }
      });
    },
    /** What the dialog shows; the host is read, never written. */
    async status(organizationId: string, botId: string): Promise<BotRoutineToolDto | null> {
      let bot = (await readBots(db, organizationId, botId))[0];
      if (!bot) return null;
      const host = await resolveHost(db, organizationId);
      if (host.block === null && bot.restartPendingSince && host.features.includes(RELAY_FEATURE_GATEWAY_RESTART)) {
        await settleRestart(db, organizationId, host.client);
        bot = (await readBots(db, organizationId, botId))[0] ?? bot;
      }
      return routineToolStatus(bot, { block: host.block, runtimeId: host.runtime?.id ?? null, features: host.features }, new Date());
    },
  };
}
