/**
 * 0187: « Programmer depuis le chat » on by default, on a real PostgreSQL
 * under openedbot_api (installer) and openedbot_worker (run context).
 *
 * The fake host models what edge-setup does: one root entry with its token,
 * a token copied into a profile only when the server is enabled THERE through
 * the host, and a profile created after the root entry inheriting the entry,
 * enabled, without the token (seen on the lab host, 2026-11-12).
 *
 * Proves: the migration keeps every existing choice; a new bot gets the tool
 * without anyone touching a switch, an inherited entry proving nothing; a
 * switched-off bot gets the server written off its profile, inherited entry
 * included; two replicas at once mint ONE secret, and a new secret reaches
 * EVERY bot; the passes never wait for the organization's profile lock nor
 * write a profile being created, imported, archived or deleted; offline, too
 * old, unreachable: a reason, no hot loop, a root pause after a few failed
 * root writes lifted by a reconnection or the operator; no gateway restart,
 * `restart_pending` lifted on the host's own word; drift found by the
 * verification; the sweep picks only organizations with work due; the run
 * context says `enabled` only when the tool is proven and served.
 */
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import { createRoutineToolInstaller, type RoutineToolInstallClient } from "../../apps/api/src/routes/execution/routine-tool-install";
import { routineToolSecretHash } from "../../apps/api/src/routes/execution/routine-tool-routes";
import { HttpError } from "../../apps/api/src/interfaces/http/http-error";
import { HermesClientError } from "../../platform/hermes/src/errors";
import { claimRun } from "../../modules/execution/src/application/queue";
import { readContext } from "../../modules/execution/src/application/runner/context";
import { admitUserTurnTx } from "../../modules/execution/src/application/run-creation";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `91870000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1), USER = id(2), SECTION = id(3), RUNTIME = id(4);
const LEGACY_ON = id(10), LEGACY_UNLISTED = id(11), FRESH = id(12), ROOTLESS = id(13), CLONING = id(14);
const LIVE = ["mcp_management", "profile_capabilities", "mcp_live_reload", "gateway_restart"];
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

type Host = ReturnType<typeof fakeHost>;
type ProfileEntry = { enabled: boolean; token: string | null };
function fakeHost(features: string[]) {
  const state = {
    features,
    offline: false,
    apiReachable: true,
    addDelayMs: 0,
    root: null as { token: string; enabled: boolean } | null,
    profiles: new Map<string, Map<string, ProfileEntry>>(),
    adds: 0,
    profileWrites: 0,
    capabilityReads: 0,
    restarts: 0,
    restartPending: false,
  };
  const live = () => state.features.includes("mcp_live_reload");
  /** A profile created now: a copy of the root config, enabled entry included, without the token. */
  const createProfile = (name: string) => {
    const entries = new Map<string, ProfileEntry>();
    if (state.root) entries.set("openedbot_routines", { enabled: state.root.enabled, token: null });
    state.profiles.set(name, entries);
  };
  const client: RoutineToolInstallClient & { gatewayRestart(): Promise<never> } = {
    hostCapabilities: async () => { state.capabilityReads += 1; return state.features; },
    mcpInventory: async () => ({ platform: "api_server", catalog: [], servers: state.root ? [{ name: "openedbot_routines", configEnabled: state.root.enabled }] : [] }) as never,
    mcpServerAdd: async (request) => {
      state.adds += 1;
      await Bun.sleep(state.addDelayMs);
      state.root = { token: request.token!, enabled: state.apiReachable };
      if (!live()) state.restartPending = true;
      return { name: request.name, discoveredTools: state.apiReachable ? ["routine_manage"] : null, unreachable: !state.apiReachable } as never;
    },
    hostSetProfileMcpServer: async (profile, name, enabled) => {
      state.profileWrites += 1;
      const entries = state.profiles.get(profile);
      if (!entries) throw new HermesClientError("no profile", 404, "PROFILE_NOT_FOUND");
      const entry = entries.get(name) ?? (state.root ? { enabled: false, token: null } : null);
      if (!entry) throw new HermesClientError("no server", 404, "MCP_SERVER_NOT_FOUND");
      // edge-setup copies the root token into the profile when it enables the server there.
      entries.set(name, { enabled, token: enabled ? state.root!.token : entry.token });
      if (!live()) state.restartPending = true;
      return { name, profile, enabled, requested: enabled, applied: true };
    },
    hostProfileInventory: async () => ({
      profiles: [...state.profiles].map(([name, entries]) => ({
        name, mcpServers: [...entries].map(([server, entry]) => ({ name: server, enabled: entry.enabled })),
      })),
    }) as never,
    gatewayStatus: async () => ({ restartPending: state.restartPending, pendingSince: null, activeSince: null, job: null }) as never,
    // Never called: nothing here may restart a gateway.
    gatewayRestart: async () => { state.restarts += 1; throw new Error("the installer must never restart a gateway"); },
  };
  return { state, client, createProfile };
}

await withDisposablePostgres("openedbot187_routine_tool_install", async ({ owner, connect, migrateRest }) => {
  await owner`insert into users (id, email) values (${USER}, 'r187@example.test')`;
  await owner`insert into organizations (id, slug, name) values (${ORG}, 'r187', 'R187')`;
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'S', 0)`;
  const linkHash = new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex");
  await owner`insert into runtimes (id, organization_id, name, reachability, is_active, capacity, link_last_seen_at, link_connected_at, link_token_hash, link_features)
    values (${RUNTIME}, ${ORG}, 'Fixture connector', 'connector', true, 8, now(), now() - interval '1 hour', ${linkHash}, ${LIVE}::text[])`;
  let position = 0;
  for (const [bot, profile] of [[LEGACY_ON, "legacy-on"], [LEGACY_UNLISTED, "legacy-unlisted"]] as const) {
    await owner`insert into bots (id, organization_id, section_id, name, slug, position, hermes_profile, hermes_profile_managed, permission_mode)
      values (${bot}, ${ORG}, ${SECTION}, ${profile}, ${profile}, ${position++}, ${profile}, true, 'auto')`;
  }
  // 0105 state: one bot switched on, an id of a deleted bot, one never chosen.
  await owner`insert into runtime_routine_tools (organization_id, runtime_id, secret_hash, installed_at, enabled_bot_ids)
    values (${ORG}, ${RUNTIME}, ${routineToolSecretHash("legacy-secret")}, now() - interval '3 days', ${`{${LEGACY_ON},${id(99)}}`}::uuid[])`;
  await migrateRest();
  const migrated = await owner<Array<{ bot: string; enabled: boolean; ready: boolean; off: boolean }>>`
    select bot_id as bot, enabled_at is not null as enabled, ready_at <= now() as ready, switched_off as off from bot_routine_tools`;
  assert(migrated.length === 1 && migrated[0]!.bot === LEGACY_ON && migrated[0]!.enabled && migrated[0]!.ready && !migrated[0]!.off,
    `0187 must keep the listed bot on with its proof and nothing else: ${JSON.stringify(migrated)}`);

  const addBot = async (bot: string, profile: string | null, provision: string | null = "succeeded") => {
    await owner`insert into bots (id, organization_id, section_id, name, slug, position, hermes_profile, hermes_profile_managed, permission_mode)
      values (${bot}, ${ORG}, ${SECTION}, ${`b${position}`}, ${`b${position}`}, ${position++}, ${profile}, ${profile !== null}, 'auto')`;
    if (provision) {
      await owner`insert into bot_profile_provisions (bot_id, organization_id, runtime_id, slug, display_name, status)
        values (${bot}, ${ORG}, ${RUNTIME}, ${profile}, ${profile}, ${provision})`;
    }
  };
  await addBot(FRESH, "fresh");
  await addBot(ROOTLESS, null, null);
  await addBot(CLONING, "cloning", "running");

  const config = { environment: "production", publicUrl: "https://api.example.test" } as ApiConfig;
  const installerOn = async (host: Host, overrides: Partial<ApiConfig> = {}) => {
    const db = await connect("openedbot_api");
    return {
      db,
      installer: createRoutineToolInstaller(db, { ...config, ...overrides } as ApiConfig, {
        readRuntime: (async () => {
          if (host.state.offline) throw new HttpError(503, "RUNTIME_LINK_UNAVAILABLE", "Le lien est coupé.");
          return { id: RUNTIME, name: "r", capacity: 8, linkFeatures: host.state.features, client: {} as never, selectedProvider: null, selectedModel: null, reasoningEffort: null };
        }) as never,
        clientFactory: () => host.client,
      }),
    };
  };
  const row = async (bot: string) => (await owner<Array<{
    enabled: boolean; disabled: boolean; ready: boolean | null; restart: boolean; reason: string | null; attempts: number; backoff: boolean; off: boolean;
  }>>`select enabled_at is not null as enabled, disabled_at is not null as disabled, ready_at <= now() as ready,
             restart_pending_since is not null as restart, blocked_reason as reason, attempts,
             coalesce(next_attempt_at > now(), false) as backoff, switched_off as off
        from bot_routine_tools where bot_id = ${bot}`)[0];
  const secret = async () => (await owner<Array<{ hash: string; installed: boolean; failures: number }>>`
    select secret_hash as hash, installed_at is not null as installed, root_failures as failures from runtime_routine_tools where runtime_id = ${RUNTIME}`)[0]!;
  const due = async (db: { unsafe(query: string): Promise<unknown> }) =>
    (await db.unsafe("select routine_tool_due_organizations(10) as id") as Array<{ id: string }>).map((entry) => entry.id);

  // 1. The lab case: the root entry exists (written with a secret this cloud
  //    no longer knows), and profiles created since inherited it enabled,
  //    without the token. Two replicas at once: ONE new secret, the host's;
  //    every ready bot is written through the host (token copied), the bot
  //    being created is left alone.
  const host = fakeHost(LIVE);
  host.state.root = { token: "x".repeat(43), enabled: true };
  for (const name of ["legacy-on", "legacy-unlisted", "fresh"]) host.createProfile(name);
  assert(host.state.profiles.get("fresh")!.get("openedbot_routines")?.enabled === true, "fixture: the new profile inherited the entry enabled");
  await owner`update runtime_routine_tools set installed_at = null where runtime_id = ${RUNTIME}`;
  const api = await connect("openedbot_api");
  assert((await due(api)).includes(ORG), "an organization with bots to install is due for the sweep");
  host.state.addDelayMs = 150;
  const [a, b] = [await installerOn(host), await installerOn(host)];
  const outcomes = await Promise.all([a.installer.reconcileNow(ORG), b.installer.reconcileNow(ORG)]);
  assert(host.state.adds === 1 && outcomes.sort().join() === "busy,done", `two replicas: one pass, one secret (adds ${host.state.adds}, ${outcomes})`);
  const stored = await secret();
  assert(stored.installed && stored.hash === routineToolSecretHash(host.state.root!.token), "the database hash must match the host's token");
  for (const [bot, profile] of [[LEGACY_ON, "legacy-on"], [LEGACY_UNLISTED, "legacy-unlisted"], [FRESH, "fresh"], [ROOTLESS, null]] as const) {
    const state = await row(bot);
    assert(state?.enabled && state.ready === false && !state.restart, `${bot} must be on by default and settling: ${JSON.stringify(state)}`);
    if (profile) assert(host.state.profiles.get(profile)!.get("openedbot_routines")?.token === host.state.root!.token, `${profile} must hold the new token`);
  }
  assert(!(await row(CLONING))?.enabled, "a bot whose profile is being created must not be touched");
  host.state.addDelayMs = 0;

  // 2. The run context: `not_ready` (inherited entry, settling), then `enabled`.
  const worker = await connect("openedbot_worker");
  const thread = id(200), run = id(201);
  await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${thread}, ${ORG}, ${FRESH}, 'DM', 'r187-fresh', true)`;
  await owner`insert into runs (id, organization_id, thread_id, bot_id, input, user_time_zone)
    values (${run}, ${ORG}, ${thread}, ${FRESH}, 'fixture', 'Europe/Paris')`;
  const workerConfig = { workerId: "r187", billingEnforced: false, leaseSeconds: 30 } as never;
  const claimed = await claimRun(worker, workerConfig);
  assert(claimed?.id === run, "the fixture run must be claimed");
  const context = async () => (await readContext(worker, workerConfig, claimed))!;
  assert((await context()).routineTool === "not_ready" && !(await context()).routineToolEnabled, "a settling tool is not announced");
  assert((await context()).routineUserTimezone === "Europe/Paris", "the run carries the zone its message came with");
  await owner`update bot_routine_tools set ready_at = now() - interval '1 second' where bot_id = ${FRESH}`;
  assert((await context()).routineTool === "enabled" && (await context()).routineToolEnabled, "a proven, served tool is announced");
  await owner`update bots set permission_mode = 'plan' where id = ${FRESH}`;
  assert((await context()).routineTool === "plan_mode", "a plan-mode bot writes no routine");
  await owner`update bots set permission_mode = 'auto' where id = ${FRESH}`;

  // The message's zone reaches the run that answers it through the run-creation command.
  const ADMITTED = id(202);
  await owner.begin((tx) => admitUserTurnTx(tx as never, {
    organizationId: ORG, threadId: thread, runId: ADMITTED, initiatorUserId: USER, input: "rappel", planOnly: false,
    userTimeZone: "America/New_York", speaker: { kind: "root", botId: FRESH }, workflow: null, admissionTimeoutSeconds: 600,
  }));
  const admitted = await owner<Array<{ zone: string | null }>>`select user_time_zone as zone from runs where id = ${ADMITTED}`;
  assert(admitted[0]?.zone === "America/New_York", "a user turn must carry its message's zone");
  await owner`delete from runs where id = ${ADMITTED}`;

  // 3. A secret minted again reaches EVERY bot, not only the one that started it.
  host.state.root = null;
  await owner`update bot_profile_provisions set status = 'succeeded' where bot_id = ${CLONING}`;
  host.createProfile("cloning");
  await a.installer.reconcileNow(ORG);
  for (const name of ["legacy-on", "legacy-unlisted", "fresh", "cloning"]) {
    assert(host.state.profiles.get(name)!.get("openedbot_routines")?.token === host.state.root!.token, `${name} must hold the re-minted token`);
  }
  // A converged organization costs no host write.
  const writesBefore = host.state.profileWrites;
  await a.installer.reconcileNow(ORG);
  assert(host.state.profileWrites === writesBefore && (host.state.adds as number) === 2, "a converged organization must cost no host write");

  // 4. The opt-out: remembered, written off the profile (inherited entry
  //    included), never undone; the run is told at once.
  await a.installer.setSwitchedOff(ORG, FRESH, true, USER);
  assert((await context()).routineTool === "switched_off", "a switched-off bot is told so at once, host or not");
  await a.installer.reconcileNow(ORG);
  assert(host.state.profiles.get("fresh")!.get("openedbot_routines")?.enabled === false && (await row(FRESH))?.disabled, "the switch-off must reach the host");
  await a.installer.reconcileNow(ORG);
  assert(host.state.profiles.get("fresh")!.get("openedbot_routines")?.enabled === false && !(await row(FRESH))?.enabled, "the opt-out is never undone");
  const INHERITED_OFF = id(18);
  host.createProfile("inherited-off");
  await addBot(INHERITED_OFF, "inherited-off");
  await a.installer.setSwitchedOff(ORG, INHERITED_OFF, true, USER);
  await a.installer.reconcileNow(ORG);
  assert(host.state.profiles.get("inherited-off")!.get("openedbot_routines")?.enabled === false && (await row(INHERITED_OFF))?.disabled,
    "a switched-off bot whose profile inherited the entry enabled must have it written off");
  await a.installer.setSwitchedOff(ORG, FRESH, false, USER);
  await a.installer.reconcileNow(ORG);
  assert(host.state.profiles.get("fresh")!.get("openedbot_routines")?.enabled === true && (await row(FRESH))?.enabled, "switching back on installs again");

  // 5. The organization's profile lock held elsewhere (bot creation, an
  //    import): the pass does not wait, writes no profile, and the next one does.
  const NEWCOMER = id(15);
  host.createProfile("newcomer");
  await addBot(NEWCOMER, "newcomer");
  const holder = await connect();
  await holder`select pg_advisory_lock(hashtext(${ORG}), hashtext('hermes-profile-import'))`;
  const startedAt = Date.now();
  await a.installer.reconcileNow(ORG);
  assert(Date.now() - startedAt < 5_000 && !(await row(NEWCOMER))?.enabled, "a held profile lock is skipped, not waited for");
  await holder`select pg_advisory_unlock(hashtext(${ORG}), hashtext('hermes-profile-import'))`;
  await a.installer.reconcileNow(ORG);
  assert((await row(NEWCOMER))?.enabled, "the next pass writes the profile");

  // 6. Archived or deleting: never written, proof voided, choice kept.
  await owner`update bots set archived_at = now() where id = ${NEWCOMER}`;
  const archivedWrites = host.state.profileWrites;
  await a.installer.reconcileNow(ORG);
  assert(host.state.profileWrites === archivedWrites && !(await row(NEWCOMER))?.enabled, "an archived bot is not written and loses its proof");
  await owner`update bots set archived_at = null where id = ${NEWCOMER}`;
  await a.installer.reconcileNow(ORG);
  assert((await row(NEWCOMER))?.enabled, "a restored bot is installed again on its profile");

  // 7. Offline then back: a reason, no write, no backoff; too old: unavailable for an hour.
  const LATECOMER = id(16);
  host.createProfile("latecomer");
  await addBot(LATECOMER, "latecomer");
  host.state.offline = true;
  const offlineWrites = host.state.profileWrites;
  await a.installer.reconcileNow(ORG);
  const offline = await row(LATECOMER);
  assert(offline?.reason === "host_offline" && offline.attempts === 0 && !offline.backoff && host.state.profileWrites === offlineWrites,
    `an offline host writes nothing and does not back off: ${JSON.stringify(offline)}`);
  host.state.offline = false;
  const old = fakeHost(["mcp_management", "profile_capabilities"]);
  await (await installerOn(old)).installer.reconcileNow(ORG);
  assert(old.state.adds + old.state.profileWrites === 0 && (await row(LATECOMER))?.reason === "host_unsupported" && (await row(LATECOMER))?.backoff,
    "a host without live reload nor restart is unavailable and looked at again later");
  await owner`update bot_routine_tools set next_attempt_at = null where bot_id = ${LATECOMER}`;
  await a.installer.reconcileNow(ORG);
  assert((await row(LATECOMER))?.enabled, "back on a capable host, the tool is installed");

  // 8. The host cannot reach the API: backoff, no hot loop, a root pause after
  //    three failed root writes in one link session, lifted by a reconnection.
  const lost = fakeHost(LIVE);
  lost.state.profiles = host.state.profiles;
  lost.state.apiReachable = false;
  const lostInstaller = (await installerOn(lost)).installer;
  await lostInstaller.reconcileNow(ORG);
  assert(lost.state.adds === 1 && (await row(FRESH))?.reason === "host_unreachable" && (await row(FRESH))?.backoff && !(await row(FRESH))?.enabled,
    "an unconfirmed new secret voids every proof and backs off");
  await lostInstaller.reconcileNow(ORG);
  assert(lost.state.adds === 1, "the inventory signal of the failed write must not loop");
  for (let index = 0; index < 3; index += 1) {
    await owner`update bot_routine_tools set next_attempt_at = null where organization_id = ${ORG}`;
    await lostInstaller.reconcileNow(ORG);
  }
  assert((lost.state.adds as number) === 3 && (await secret()).failures === 3, `root writes stop after three failures (adds ${lost.state.adds})`);
  assert((await row(FRESH))?.backoff, "a paused root holds the bots for hours");
  await owner`update runtimes set link_connected_at = now() where id = ${RUNTIME}`;
  await owner`update bot_routine_tools set next_attempt_at = null where organization_id = ${ORG}`;
  lost.state.apiReachable = true;
  await lostInstaller.reconcileNow(ORG);
  assert((lost.state.adds as number) === 4 && (await row(FRESH))?.enabled && (await secret()).failures === 0, "a reconnection lifts the pause");

  // 9. No live reload: never restarted; `restart_pending` until the host says so.
  const slow = fakeHost(["mcp_management", "profile_capabilities", "gateway_restart"]);
  slow.state.root = lost.state.root;
  slow.state.profiles = lost.state.profiles;
  const slowInstaller = (await installerOn(slow)).installer;
  const LATE = id(17);
  slow.createProfile("late");
  await addBot(LATE, "late");
  await slowInstaller.reconcileNow(ORG);
  assert((await row(LATE))?.enabled && (await row(LATE))?.restart && slow.state.restartPending, "no live reload leaves a restart pending");
  assert((await slowInstaller.status(ORG, LATE))?.status === "restart_pending", "the dialog shows the pending restart");
  await slowInstaller.reconcileNow(ORG);
  assert((await row(LATE))?.backoff, "a restart still pending is looked at again later, not every minute");
  slow.state.restartPending = false;
  assert((await slowInstaller.status(ORG, LATE))?.status === "active" && (await row(LATE))?.ready, "the host's word lifts the wait");
  assert(slow.state.restarts + host.state.restarts + lost.state.restarts + old.state.restarts === 0, "no gateway was restarted");

  // 10. Drift: a profile switched by hand is found by the verification and written again.
  lost.state.profiles.get("fresh")!.set("openedbot_routines", { enabled: false, token: null });
  await owner`update runtime_routine_tools set verified_at = now() - interval '1 hour' where runtime_id = ${RUNTIME}`;
  await lostInstaller.reconcileNow(ORG);
  assert(lost.state.profiles.get("fresh")!.get("openedbot_routines")?.enabled === true && (await row(FRESH))?.enabled, "a drifted profile is written again");

  // 11. Converged: the sweep has nothing to do for this organization.
  await owner`update bot_routine_tools set next_attempt_at = null where organization_id = ${ORG}`;
  await lostInstaller.reconcileNow(ORG);
  const pending = await owner<Array<{ bot: string }>>`
    select bot_id as bot from bot_routine_tools where organization_id = ${ORG}
       and not switched_off and (enabled_at is null or restart_pending_since is not null)`;
  assert(pending.length === 0 && !(await due(api)).includes(ORG), `a converged organization is not swept: ${JSON.stringify(pending)}`);

  // 12. A burst of host signals: one pass at a time, plus ONE more.
  const readsBefore = host.state.capabilityReads;
  for (let index = 0; index < 5; index += 1) a.installer.schedule(ORG);
  await a.installer.idle();
  assert(host.state.capabilityReads - readsBefore === 2, `five signals must cost two passes (got ${host.state.capabilityReads - readsBefore})`);

  for (const connection of [a.db, b.db, api, holder]) await connection.close();
  await worker.close();
  console.log("routine-tool-install: migration choices, default-on with inherited entries, opt-out written off the profile, one secret reaching every bot, no wait on the profile lock, archived/offline/unsupported/unreachable with root pause, restart pending on the host's word, drift, sweep, truthful run context proven");
}, { stopBefore: "0187_" });
