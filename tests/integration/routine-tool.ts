/**
 * DEV-209: `routine_manage` on a real PostgreSQL, under openedbot_api and tenant RLS.
 *
 * Proves: the MCP handshake and the per-runtime bearer, the run key (signed by
 * the worker secret, live run only), the per-bot state of 0187 (proven on this
 * runtime, switched off by the operator), the timezone rule (a time of day
 * needs an explicit zone, never UTC by default), each permission mode
 * (bypass writes, manual creates active and refuses resume/remove, plan writes
 * nothing), the routine-run guard, the schedule forms and minimum interval,
 * and that a tenant's bearer never reaches another tenant's run.
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { Hono } from "hono";
import type { AppVariables } from "../../apps/api/src/routes/identity/auth";
import { routineToolMcpRoutes, routineToolSecretHash } from "../../apps/api/src/routes/execution/routine-tool-routes";
import { HttpError } from "../../apps/api/src/interfaces/http/http-error";
import { signRoutineRunKey } from "../../modules/execution/src/application/routine-run-key";
import { fireDueRoutine, readRoutines } from "../../modules/execution/src/application/routines";
import { markLinkConnected } from "../../modules/runtimes/src/application/runtime-link-rows";
import { routineRoutes } from "../../apps/api/src/routes/execution/routine-routes";
import { withTenant } from "../../platform/db/src/db";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `92090000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_A = id(1), ORG_B = id(2), USER = id(3), SECTION = id(4), RUNTIME_A = id(5), RUNTIME_B = id(6);
const BYPASS = id(10), MANUAL = id(11), PLAN = id(12), OFF = id(13), BOT_B = id(14);
const SECRET = "integration-worker-secret";
const BEARER_A = "bearer-a", BEARER_B = "bearer-b";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

await withDisposablePostgres("openedbot209_routine_tool", async ({ owner, connect }) => {
  await owner`insert into users (id, email) values (${USER}, 'dev209@example.test')`;
  await owner`insert into organizations (id, slug, name) values (${ORG_A}, 'dev209-a', 'A'), (${ORG_B}, 'dev209-b', 'B')`;
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG_A}, ${USER}, 'owner')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG_A}, 'S', 0)`;
  await owner`insert into sections (id, organization_id, name, position) values (${id(7)}, ${ORG_B}, 'S', 0)`;
  for (const [runtime, org] of [[RUNTIME_A, ORG_A], [RUNTIME_B, ORG_B]] as const) {
    await owner`insert into runtimes (id, organization_id, name, endpoint, token_ciphertext, token_nonce, token_tag, is_active)
      values (${runtime}, ${org}, 'fixture', 'http://127.0.0.1:8123', 'c', 'n', 't', true)`;
  }
  const runs = new Map<string, string>();
  let n = 100;
  for (const [bot, org, section, mode] of [
    [BYPASS, ORG_A, SECTION, "bypass"], [MANUAL, ORG_A, SECTION, "manual"], [PLAN, ORG_A, SECTION, "plan"],
    [OFF, ORG_A, SECTION, "bypass"], [BOT_B, ORG_B, id(7), "bypass"],
  ] as const) {
    const thread = id(n++), run = id(n++);
    await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode)
      values (${bot}, ${org}, ${section}, ${`b${n}`}, ${`b${n}`}, ${n}, ${mode})`;
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${thread}, ${org}, ${bot}, 'DM', ${`dev209-${n}`}, true)`;
    await owner`insert into runs (id, organization_id, thread_id, bot_id, input, status, external_state)
      values (${run}, ${org}, ${thread}, ${bot}, 'fixture', 'running', 'streaming')`;
    runs.set(bot, run);
  }
  await owner`insert into runtime_routine_tools (organization_id, runtime_id, secret_hash, installed_at)
    values (${ORG_A}, ${RUNTIME_A}, ${routineToolSecretHash(BEARER_A)}, now()),
           (${ORG_B}, ${RUNTIME_B}, ${routineToolSecretHash(BEARER_B)}, now())`;
  // 0187: the tool proven on each bot's profile; OFF was switched off by the operator.
  for (const [bot, org, runtime] of [[BYPASS, ORG_A, RUNTIME_A], [MANUAL, ORG_A, RUNTIME_A], [PLAN, ORG_A, RUNTIME_A], [BOT_B, ORG_B, RUNTIME_B]] as const) {
    await owner`insert into bot_routine_tools (organization_id, bot_id, runtime_id, enabled_at, ready_at)
      values (${org}, ${bot}, ${runtime}, now(), now())`;
  }
  await owner`insert into bot_routine_tools (organization_id, bot_id, switched_off) values (${ORG_A}, ${OFF}, true)`;

  const db = await connect("openedbot_api");
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ code: error.code }, error.status as 401)
    : context.json({ code: "INTERNAL" }, 500));
  app.route("/api/mcp/routines", routineToolMcpRoutes(db, testInternalSecrets("api", SECRET)));

  let rpc = 0;
  const post = (org: string, bearer: string | null, body: unknown) => app.request(`/api/mcp/routines/${org}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const call = async (bot: string, args: Record<string, unknown>, options: { org?: string; bearer?: string; runKey?: string } = {}) => {
    const response = await post(options.org ?? ORG_A, options.bearer ?? BEARER_A, {
      jsonrpc: "2.0", id: ++rpc, method: "tools/call",
      params: { name: "routine_manage", arguments: { run_key: options.runKey ?? signRoutineRunKey(SECRET, runs.get(bot)!), ...args } },
    });
    assert(response.status === 200, `tools/call status ${response.status}`);
    const json = await response.json() as { result: { content: Array<{ text: string }>; isError: boolean } };
    return { error: json.result.isError, text: json.result.content[0]!.text };
  };

  // Handshake and bearer.
  assert((await post(ORG_A, null, { jsonrpc: "2.0", id: 1, method: "ping" })).status === 401, "no bearer must be 401");
  assert((await post(ORG_A, BEARER_B, { jsonrpc: "2.0", id: 1, method: "ping" })).status === 401, "another tenant's bearer must be 401");
  // A refused bearer marks the runtime for the sweep's verification, at most every 10 minutes.
  const marked = await owner<Array<{ at: Date | null }>>`select auth_failed_at as at from runtime_routine_tools where organization_id = ${ORG_A}`;
  assert(marked[0]?.at, "a refused bearer must mark the runtime");
  assert((await post(ORG_A, "wrong", { jsonrpc: "2.0", id: 1, method: "ping" })).status === 401, "a wrong bearer stays 401");
  const again = await owner<Array<{ at: Date | null }>>`select auth_failed_at as at from runtime_routine_tools where organization_id = ${ORG_A}`;
  assert(again[0]?.at?.getTime() === marked[0].at.getTime(), "a second refusal within 10 minutes must not move the mark");
  const init = await (await post(ORG_A, BEARER_A, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json() as { result: { protocolVersion: string } };
  assert(init.result.protocolVersion === "2025-06-18", "initialize must echo a supported version");
  assert((await post(ORG_A, BEARER_A, { jsonrpc: "2.0", method: "notifications/initialized" })).status === 202, "notification must be 202");
  const listed = await (await post(ORG_A, BEARER_A, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as { result: { tools: Array<{ name: string }> } };
  assert(listed.result.tools.map((tool) => tool.name).join() === "routine_manage", "tools/list must serve routine_manage only");

  // A time of day is never read in UTC by default: no zone, no routine.
  const noZone = await call(BYPASS, { action: "create", name: "Point", prompt: "Fais le point", schedule: "every friday at 17:00" });
  assert(noZone.error && noZone.text.startsWith("timezone is required"), `a time of day without a zone must be refused: ${noZone.text}`);
  // A local one-shot is read in the given zone: 9:00 in Paris on 13 November is 8:00 UTC.
  const local = await call(BYPASS, { action: "create", name: "Rappel", prompt: "Rappelle", schedule: "at 2099-11-13T09:00", timezone: "Europe/Paris" });
  const localJob = (JSON.parse(local.text) as { created: { job_id: string; schedule: string; timezone: string } }).created;
  assert(!local.error && localJob.schedule === "at 2099-11-13T08:00:00.000Z" && localJob.timezone === "Europe/Paris",
    `a local one-shot must be stored as its UTC instant with its zone: ${local.text}`);
  // A hand-made routine in another zone is NOT the user's zone (0187: no inference).
  await owner`insert into routines (id, organization_id, bot_id, created_by_user_id, name, schedule, timezone, message, enabled)
    values (${id(400)}, ${ORG_A}, ${MANUAL}, ${USER}, 'Manual', '0 8 * * 1', 'America/Toronto', 'm', false)`;
  const unknownZone = await call(BYPASS, { action: "create", name: "Abs", prompt: "x", schedule: "in 3h" });
  const unknownJob = (JSON.parse(unknownZone.text) as { created: { job_id: string; timezone: string } }).created;
  assert(!unknownZone.error && unknownJob.timezone === "UTC", `without the client's zone an absolute instant shows in UTC: ${unknownZone.text}`);
  // The zone the person's client sent with the message this run answers.
  await owner`update runs set user_time_zone = 'Asia/Tokyo' where id = ${runs.get(BYPASS)!}`;
  const absolute = await call(BYPASS, { action: "create", name: "Abs2", prompt: "x", schedule: "in 3h" });
  const absoluteJob = (JSON.parse(absolute.text) as { created: { job_id: string; timezone: string } }).created;
  assert(!absolute.error && absoluteJob.timezone === "Asia/Tokyo", `a zone-free one-shot must show the run's user zone: ${absolute.text}`);
  // Spring forward: a local time the clocks skip is refused with its reason, never moved.
  const skipped = await call(BYPASS, { action: "create", name: "Gap", prompt: "x", schedule: "at 2099-03-08T02:30", timezone: "America/New_York" });
  assert(skipped.error && skipped.text.includes("daylight saving"), `a skipped local time must be refused: ${skipped.text}`);
  for (const job of [localJob.job_id, absoluteJob.job_id, unknownJob.job_id]) assert(!(await call(BYPASS, { action: "remove", job_id: job })).error, "fixture removal");
  await owner`delete from routines where id = ${id(400)}`;

  // Bypass: write, read back, update, pause, remove.
  const created = await call(BYPASS, { action: "create", name: "News IA", prompt: "Cherche les news IA", schedule: "daily at 9am", timezone: "Europe/Paris" });
  assert(!created.error, `bypass create failed: ${created.text}`);
  const jobId = (JSON.parse(created.text) as { created: { job_id: string; enabled: boolean; schedule: string } }).created;
  assert(jobId.enabled && jobId.schedule === "0 9 * * *", "bypass create must be enabled with the normalized cron");
  const stored = await owner<Array<{ enabled: boolean; next: Date | null; by: string | null }>>`
    select enabled, next_run_at as next, created_by_user_id as by from routines where id = ${jobId.job_id}`;
  assert(stored[0]?.enabled && stored[0].next && stored[0].by === null, "the routine row must be enabled with a next run");
  // PERM2-9: a routine the bot creates never waits for a person, and the bot cannot move that.
  const neverWait = async (routine: string) =>
    (await owner<Array<{ neverWait: boolean }>>`select never_wait as "neverWait" from routines where id = ${routine}`)[0]?.neverWait;
  assert(await neverWait(jobId.job_id) === true, "a bot-created routine must be born never_wait");
  assert((JSON.parse(created.text) as { created: { never_wait: boolean } }).created.never_wait === true, "the tool view must say never_wait");
  await owner`update routines set never_wait = false where id = ${jobId.job_id}`;
  // A new time of day on update needs its zone too: the stored one may be a UTC default.
  const updateNoZone = await call(BYPASS, { action: "update", job_id: jobId.job_id, schedule: "weekdays at 8:30" });
  assert(updateNoZone.error && updateNoZone.text.startsWith("timezone is required"), `an update to a time of day without a zone must be refused: ${updateNoZone.text}`);
  assert(!(await call(BYPASS, { action: "update", job_id: jobId.job_id, schedule: "weekdays at 8:30", timezone: "Europe/Paris" })).error, "update must pass");
  assert(await neverWait(jobId.job_id) === false, "a bot update must not move never_wait the operator set");
  assert((await owner<Array<{ schedule: string }>>`select schedule from routines where id = ${jobId.job_id}`)[0]?.schedule === "30 8 * * 1-5", "update must store the cron");
  assert(!(await call(BYPASS, { action: "pause", job_id: jobId.job_id })).error, "pause must pass");
  assert((await owner<Array<{ enabled: boolean }>>`select enabled from routines where id = ${jobId.job_id}`)[0]?.enabled === false, "pause must disable");
  // A create that repeats an existing routine (same schedule, zone, name up to
  // case and spaces; the model rewords the message) returns it unchanged and
  // inserts nothing, paused or not: a model that cannot see its earlier call
  // must not double it.
  const routineCount = async () => Number((await owner<Array<{ n: string }>>`select count(*) as n from routines where bot_id = ${BYPASS}`)[0]?.n);
  const countBefore = await routineCount();
  const twinPaused = await call(BYPASS, { action: "create", name: "  news ia ", prompt: "Trouve les dernières news IA", schedule: "weekdays at 8:30", timezone: "Europe/Paris" });
  const pausedTwin = JSON.parse(twinPaused.text) as { existing?: { job_id: string; enabled: boolean }; already_existed?: boolean; note?: string };
  assert(!twinPaused.error && pausedTwin.already_existed && pausedTwin.existing?.job_id === jobId.job_id && pausedTwin.existing.enabled === false
    && pausedTwin.note?.includes("PAUSED"), `a paused twin must be returned as is: ${twinPaused.text}`);
  assert(await routineCount() === countBefore, "a twin create must insert nothing");
  assert((await owner<Array<{ message: string }>>`select message from routines where id = ${jobId.job_id}`)[0]?.message === "Cherche les news IA",
    "a twin create must leave the existing message as it was");
  for (const differing of [
    { name: "News IA", prompt: "Cherche les news IA", schedule: "weekdays at 9:30", timezone: "Europe/Paris" },
    { name: "News crypto", prompt: "Cherche les news IA", schedule: "weekdays at 8:30", timezone: "Europe/Paris" },
    { name: "News IA", prompt: "Cherche les news IA", schedule: "weekdays at 8:30", timezone: "Europe/London" },
  ]) {
    const other = await call(BYPASS, { action: "create", ...differing });
    const otherJob = (JSON.parse(other.text) as { created?: { job_id: string } }).created;
    assert(!other.error && otherJob && otherJob.job_id !== jobId.job_id, `a differing routine must be created: ${other.text}`);
    assert(!(await call(BYPASS, { action: "remove", job_id: otherJob.job_id })).error, "fixture removal");
  }
  // Two identical creates racing: the per-bot lock lets one insert, the other finds it.
  const race = { action: "create", name: "Course", prompt: "Une seule", schedule: "daily at 7am", timezone: "Europe/Paris" };
  const raced = await Promise.all([call(BYPASS, race), call(BYPASS, race), call(BYPASS, race)]);
  const racedIds = raced.map((result) => {
    const parsed = JSON.parse(result.text) as { created?: { job_id: string }; existing?: { job_id: string } };
    return (parsed.created ?? parsed.existing)?.job_id;
  });
  const raceRows = await owner<Array<{ id: string }>>`select id from routines where bot_id = ${BYPASS} and name = 'Course'`;
  assert(raceRows.length === 1 && racedIds.every((job) => job === raceRows[0]!.id), `racing twins must leave one routine: ${JSON.stringify(racedIds)}`);
  assert(raced.filter((result) => (JSON.parse(result.text) as { created?: unknown }).created).length === 1, "exactly one racing create must insert");
  assert(!(await call(BYPASS, { action: "remove", job_id: raceRows[0]!.id })).error, "fixture removal");
  assert((await call(BYPASS, { action: "create", name: "Trop", prompt: "x", schedule: "every 5m" })).error, "every 5m must be refused");
  assert((await call(BYPASS, { action: "create", name: "Flou", prompt: "x", schedule: "parfois" })).error, "an unknown schedule must be refused");
  assert((await call(BYPASS, { action: "update", job_id: id(999), name: "x" })).error, "an unknown job_id must be refused");
  assert(!(await call(BYPASS, { action: "remove", job_id: jobId.job_id })).error, "bypass remove must pass");

  // Manual: creation is active by default; existing pause/resume/remove rights stay separate.
  const manual = await call(MANUAL, { action: "create", name: "M", prompt: "x", schedule: "hourly" });
  const manualJob = (JSON.parse(manual.text) as { created: { job_id: string; enabled: boolean } }).created;
  assert(!manual.error && manualJob.enabled === true, "manual create must be active by default");
  const manualStored = (await owner<Array<{ enabled: boolean; next: Date | null }>>`
    select enabled, next_run_at as next from routines where id = ${manualJob.job_id}`)[0];
  assert(manualStored?.enabled && manualStored.next, "manual creation must persist an active routine with a next occurrence");
  assert(await neverWait(manualJob.job_id) === true, "a manual bot-created routine must be never_wait too");
  assert(!(await call(MANUAL, { action: "pause", job_id: manualJob.job_id })).error, "manual pause must still pass");
  const manualPaused = (await owner<Array<{ enabled: boolean; next: Date | null }>>`
    select enabled, next_run_at as next from routines where id = ${manualJob.job_id}`)[0];
  assert(manualPaused?.enabled === false && manualPaused.next === null, "an explicit pause must disable the routine and clear its next occurrence");
  assert(!(await call(MANUAL, { action: "update", job_id: manualJob.job_id, name: "M paused" })).error, "manual update must still pass");
  assert((await owner<Array<{ enabled: boolean }>>`select enabled from routines where id = ${manualJob.job_id}`)[0]?.enabled === false,
    "updating a paused routine must not reactivate it");
  assert((await call(MANUAL, { action: "resume", job_id: manualJob.job_id })).error, "manual resume must be refused");
  assert((await call(MANUAL, { action: "remove", job_id: manualJob.job_id })).error, "manual remove must be refused");

  const beforeReminder = Date.now();
  const reminder = await call(BYPASS, { action: "create", name: "Nvidia", prompt: "Actu Nvidia", schedule: "in 2m" });
  assert(!reminder.error, "a two-minute one-shot must be accepted");
  const reminderId = (JSON.parse(reminder.text) as { created: { job_id: string } }).created.job_id;
  const reminderRow = (await owner<Array<{ enabled: boolean; schedule: string; next: Date }>>`
    select enabled, schedule, next_run_at as next from routines where id = ${reminderId}`)[0];
  assert(reminderRow?.enabled && reminderRow.schedule.startsWith("at "), "a reminder must persist as an active absolute one-shot");
  assert(new Date(reminderRow.next).getTime() >= beforeReminder + 120_000
    && new Date(reminderRow.next).getTime() <= Date.now() + 120_000, "two minutes must be measured from creation");
  assert(!(await call(BYPASS, { action: "remove", job_id: reminderId })).error, "fixture reminder removal must pass");

  // Plan writes nothing; a switched-off bot, a bad key and an ended run are refused.
  assert((await call(PLAN, { action: "create", name: "P", prompt: "x", schedule: "hourly" })).error, "plan create must be refused");
  assert(Number((await owner<Array<{ count: string }>>`select count(*) as count from routines where bot_id = ${PLAN}`)[0]?.count) === 0,
    "plan mode must not persist a routine");
  const off = await call(OFF, { action: "list" });
  assert(off.error && off.text.includes("switched off"), `a switched-off bot must be refused as such: ${off.text}`);
  // Proven on another runtime of the organization only: not usable here.
  await owner`update bot_routine_tools set runtime_id = ${RUNTIME_B} where bot_id = ${MANUAL}`;
  const elsewhere = await call(MANUAL, { action: "list" });
  assert(elsewhere.error && elsewhere.text.includes("not set up"), `a tool proven on another runtime must be refused: ${elsewhere.text}`);
  await owner`update bot_routine_tools set runtime_id = ${RUNTIME_A} where bot_id = ${MANUAL}`;
  assert((await call(BYPASS, { action: "list" }, { runKey: `${runs.get(BYPASS)}.forged` })).error, "a forged key must be refused");
  await owner`update runs set status = 'completed' where id = ${runs.get(PLAN)}`;
  assert((await call(PLAN, { action: "list" })).error, "an ended run must be refused");

  // A run fired by a routine reads, but never writes.
  const routine = id(500);
  await owner`insert into routines (id, organization_id, bot_id, name, schedule, timezone, message, enabled)
    values (${routine}, ${ORG_A}, ${BYPASS}, 'R', '0 9 * * *', 'UTC', 'm', true)`;
  await owner`insert into routine_executions (organization_id, routine_id, outcome, trigger, run_id)
    values (${ORG_A}, ${routine}, 'fired', 'scheduled', ${runs.get(BYPASS)})`;
  assert(!(await call(BYPASS, { action: "list" })).error, "a routine run may list");
  assert((await call(BYPASS, { action: "create", name: "R2", prompt: "x", schedule: "hourly" })).error, "a routine run must not create");

  // Tenant B's valid bearer and key never reach tenant A's run.
  const cross = await call(BOT_B, { action: "list" }, { org: ORG_B, bearer: BEARER_B, runKey: signRoutineRunKey(SECRET, runs.get(BYPASS)!) });
  assert(cross.error, "another tenant's run must not be visible");
  assert(!(await call(BOT_B, { action: "list" }, { org: ORG_B, bearer: BEARER_B })).error, "tenant B lists its own");

  // S1b: one secret per role. The run key is signed with RUN_KEY_SECRET; the former
  // secret reads only the keys of runs created before RUN_KEY_PREVIOUS_CREATED_BEFORE.
  const NEW_SECRET = "integration-run-key-secret";
  const listWith = async (env: Record<string, string>, runKey: string) => {
    const scoped = new Hono<{ Variables: AppVariables }>();
    scoped.route("/api/mcp/routines", routineToolMcpRoutes(db, testInternalSecrets("api", env)));
    const response = await scoped.request(`/api/mcp/routines/${ORG_A}`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${BEARER_A}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name: "routine_manage", arguments: { run_key: runKey, action: "list" } } }),
    });
    const json = await response.json() as { result: { content: Array<{ text: string }>; isError: boolean } };
    return { error: json.result.isError, text: json.result.content[0]!.text };
  };
  const live = runs.get(BYPASS)!;
  const createdAt = (await owner<Array<{ at: Date }>>`select created_at as at from runs where id = ${live}`)[0]!.at;
  const after = new Date(createdAt.getTime() + 60_000).toISOString();
  const before = new Date(createdAt.getTime() - 60_000).toISOString();
  const oldKey = signRoutineRunKey(SECRET, live), newKey = signRoutineRunKey(NEW_SECRET, live);
  assert(!(await listWith({ RUN_KEY_SECRET: NEW_SECRET }, newKey)).error, "a key signed with RUN_KEY_SECRET must pass");
  assert(!(await listWith({ RUN_KEY_SECRET: NEW_SECRET, RUN_KEY_PREVIOUS_SECRET: SECRET, RUN_KEY_PREVIOUS_CREATED_BEFORE: after }, oldKey)).error,
    "the previous secret must read the key of a run created before its bound");
  assert((await listWith({ RUN_KEY_SECRET: NEW_SECRET, RUN_KEY_PREVIOUS_SECRET: SECRET, RUN_KEY_PREVIOUS_CREATED_BEFORE: createdAt.toISOString() }, oldKey)).error,
    "a run created at the bound is outside the cohort");
  assert((await listWith({ RUN_KEY_SECRET: NEW_SECRET, RUN_KEY_PREVIOUS_SECRET: SECRET, RUN_KEY_PREVIOUS_CREATED_BEFORE: before }, oldKey)).error,
    "a key forged with the previous secret for a run created after its bound must be refused");
  assert((await listWith({ RUN_KEY_SECRET: NEW_SECRET }, oldKey)).error, "once the previous secret is removed, it must read no key");

  // Two real workers racing an overdue reminder create one durable run.
  const onceId = id(700), due = new Date(Date.now() - 2000);
  await owner`update runs set status = 'completed' where id = ${runs.get(OFF)!}`;
  await owner`insert into routines (id, organization_id, bot_id, created_by_user_id, name, schedule, timezone, message, enabled, next_run_at)
    values (${onceId}, ${ORG_A}, ${OFF}, ${USER}, 'Once', ${`at ${due.toISOString()}`}, 'UTC', 'Synthetic reminder', true, ${due})`;
  const workerA = await connect("openedbot_worker"), workerB = await connect("openedbot_worker");
  try {
    const fired = await Promise.all([fireDueRoutine(workerA, false), fireDueRoutine(workerB, false)]);
    assert(fired.filter(Boolean).length === 1, "concurrent workers must admit the reminder once");
    const state = (await owner<Array<{ enabled: boolean; next: Date | null; last: Date | null }>>`
      select enabled, next_run_at as next, last_run_at as last from routines where id = ${onceId}`)[0];
    assert(state?.enabled === false && state.next === null && state.last, "firing must atomically disable the reminder and clear its next occurrence");
  } finally { await workerA.close(); await workerB.close(); }
  const restartedWorker = await connect("openedbot_worker");
  try { assert(await fireDueRoutine(restartedWorker, false) === false, "a fresh worker must not fire the completed reminder again"); }
  finally { await restartedWorker.close(); }
  const receipts = await owner<Array<{ count: string }>>`select count(*) as count from routine_executions where routine_id = ${onceId}`;
  assert(Number(receipts[0]?.count) === 1, "the reminder must retain exactly one execution receipt");

  // Host unreachable: a due routine of an organization whose connector the
  // queue would not serve (link silent past 45 s, not yet swept) is not fired,
  // writes no history, does not hold back a later due routine of a healthy
  // organization, refuses « run now », then fires once as a catch-up when the
  // link's own functions bring the host back.
  const ORG_C = id(800), SECTION_C = id(801), RUNTIME_C = id(802), BOT_C = id(803), THREAD_C = id(804), ROUTINE_C = id(805);
  const FREE = id(806), FREE_THREAD = id(807), ROUTINE_FREE = id(808);
  const LINK_HASH_C = "c".repeat(64);
  await owner`insert into organizations (id, slug, name) values (${ORG_C}, 'dev209-c', 'C')`;
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG_C}, ${USER}, 'owner')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION_C}, ${ORG_C}, 'S', 0)`;
  await owner`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active, last_health_status, link_last_seen_at)
    values (${RUNTIME_C}, ${ORG_C}, 'Silent connector', 'connector', ${LINK_HASH_C}, true, 'healthy', now() - interval '10 minutes')`;
  for (const [bot, org, section, thread, slug] of [[BOT_C, ORG_C, SECTION_C, THREAD_C, "offline"], [FREE, ORG_A, SECTION, FREE_THREAD, "free"]] as const) {
    await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode)
      values (${bot}, ${org}, ${section}, ${slug}, ${slug}, 900, 'bypass')`;
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${thread}, ${org}, ${bot}, 'DM', ${`dev209-${slug}`}, true)`;
  }
  const hour = 3_600_000;
  const offlineDue = new Date(Math.floor(Date.now() / hour) * hour - 3 * hour);
  await owner`insert into routines (id, organization_id, bot_id, created_by_user_id, name, schedule, timezone, message, enabled, next_run_at)
    values (${ROUTINE_C}, ${ORG_C}, ${BOT_C}, null, 'Hourly', '0 * * * *', 'UTC', 'Offline host', true, ${offlineDue}),
           (${ROUTINE_FREE}, ${ORG_A}, ${FREE}, ${USER}, 'Hourly', '0 * * * *', 'UTC', 'Healthy host', true, ${new Date(Date.now() - 60_000)})`;
  const executions = async (routine: string) => owner<Array<{ outcome: string; missed: number }>>`
    select outcome, missed_count as missed from routine_executions where routine_id = ${routine}`;
  // Read as the console reads it: the API role, under the tenant's RLS.
  const waiting = async () => (await withTenant(db, ORG_C, (tx) => readRoutines(tx, ORG_C, { botId: BOT_C, groupId: null, botArchived: false })))
    .map((row) => row.waitingForHost);
  const operator = new Hono<{ Variables: AppVariables }>();
  operator.use("*", async (context, next) => {
    context.set("auth", { sessionId: id(809), organizationId: ORG_C, userId: USER, role: "owner", kind: "web", credentialHash: "x" });
    await next();
  });
  operator.onError((error, context) => error instanceof HttpError
    ? context.json({ code: error.code }, error.status as 409)
    : context.json({ code: "INTERNAL", message: String(error) }, 500));
  operator.route("/api/routines", routineRoutes(db, false));
  const tick = await connect("openedbot_worker");
  try {
    assert(await fireDueRoutine(tick, false) === true, "the healthy organization's routine must fire past the waiting one");
    assert((await executions(ROUTINE_FREE)).length === 1, "the healthy routine must fire once");
    assert(await fireDueRoutine(tick, false) === false, "a routine whose link is silent past 45 s must not be claimed");
    assert((await executions(ROUTINE_C)).length === 0, "waiting for the host must write no history");
    assert((await waiting()).join() === "true", "the list must say the routine waits for its host");
    const runNow = await operator.request(`/api/routines/${ROUTINE_C}/runs`, { method: "POST", headers: { "Idempotency-Key": id(810) } });
    const refused = await runNow.json() as { code: string };
    assert(runNow.status === 409 && refused.code === "ROUTINE_HOST_OFFLINE", `run now must be refused while the host is away: ${JSON.stringify(refused)}`);
    assert(Number((await owner<Array<{ count: string }>>`select count(*) as count from message_ingress where organization_id = ${ORG_C}`)[0]?.count) === 0,
      "a refused run now must reserve nothing");
    assert(await markLinkConnected(owner, { runtimeId: RUNTIME_C, organizationId: ORG_C, tokenHash: LINK_HASH_C },
      { instanceId: "routine-tool-instance", generation: "1", features: [] }), "the link must reconnect");
    assert((await waiting()).join() === "false", "a reachable host must not be reported as awaited");
    assert(await fireDueRoutine(tick, false) === true, "the routine must fire once its host is back");
    const caught = await executions(ROUTINE_C);
    assert(caught.length === 1 && caught[0]!.outcome === "catch_up" && caught[0]!.missed >= 2,
      "the return must fire one catch-up that counts the missed occurrences");
    const after = (await owner<Array<{ next: Date }>>`select next_run_at as next from routines where id = ${ROUTINE_C}`)[0]!;
    assert(after.next.getTime() > Date.now(), "the clock must move past now after the catch-up");
    assert(await fireDueRoutine(tick, false) === false, "nothing else is due");
  } finally { await tick.close(); }

  await db.close();
  console.log("routine-tool: handshake, modes, one-shot creation, concurrent workers, restart, tenant isolation, run-key cohort, offline-host hold, run-now refusal and catch-up proven");
});
