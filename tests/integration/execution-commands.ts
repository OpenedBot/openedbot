/**
 * S3 (ADR 0001, section 4.6): the on-demand room compaction is a durable
 * command. The API route (`openedbot_api`) records it and waits; workers
 * (`openedbot_worker`, each on its own connection) claim and execute it
 * under a fenced lease, against a disposable PostgreSQL and a fake Hermes.
 *
 *  1. Happy path: the request waits for the worker, which runs the summary
 *     on the last speaker's profile and model, keyed by the command id, and
 *     the request answers as before S3 (`ThreadCompactResult`).
 *  2. One active command per thread: a second request is refused
 *     (`COMPACTION_IN_PROGRESS`); a command no worker claims before the
 *     request's deadline is withdrawn (`COMPACTION_NOT_STARTED`) and never run.
 *  3. The API goes away between recording and pickup: the command waits in
 *     the table, a later worker runs it, and a replay under the same
 *     `Idempotency-Key` returns its result without a second summary. Two
 *     concurrent requests under one key record one command.
 *  4. A worker dies mid-command: its lease expires, another worker claims it
 *     (attempt 2, generation 2) and finishes; every write of the dead one is
 *     refused, its summary included (written under the lease, in one
 *     transaction with the command's progress). A worker that died after
 *     writing its summary but before settling: the next attempt settles the
 *     recorded progress instead of refusing a thread now below the threshold.
 *     Spent attempts fail the command (`COMMAND_ATTEMPTS_EXHAUSTED`), unless a
 *     cancellation is pending with a run on the host: it is claimed again to
 *     stop that run. A retry that cannot reuse the earlier run stops it.
 *  5. A graceful stop hands the running command back (attempt not counted);
 *     neither the queue expiry nor a request's deadline discards it, however
 *     old it is.
 *  6. Cancellation: a queued command is cancelled at once; a running one is
 *     stopped by its heartbeat, its summary run stopped on the host, and the
 *     waiting request answers 409. A cancellation asked between two
 *     heartbeats still wins over a summary that completes or fails meanwhile; one
 *     asked while a stopping worker had handed the command back is carried
 *     out by the next worker, which stops the recorded summary run.
 *  7. A run started after the request: the worker refuses (`RUN_IN_PROGRESS`).
 *  8. Tenancy and retention: the API role sees no other organization's
 *     command; settled commands past retention are deleted.
 */
import { Hono } from "hono";
import type { SQL } from "bun";
import {
  awaitExecutionCommand,
  claimNextExecutionCommand,
  executeExecutionCommand,
  submitThreadCompaction,
  type CommandHermes,
} from "../../modules/execution/src/application/execution-commands";
import {
  finishExecutionCommand,
  purgeSettledExecutionCommands,
  renewCommandLease,
} from "../../modules/execution/src/sql/execution-commands";
import type { createRuntimeClient } from "../../modules/execution/src/application/runtime-client";
import type { RuntimeLinks } from "../../modules/runtime-link/src/application/dialer";
import { threadCompactRoutes } from "../../apps/api/src/routes/conversation/thread-compact-routes";
import { HttpError } from "../../apps/api/src/interfaces/http/http-error";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import type { AppVariables, AuthContext } from "../../apps/api/src/routes/identity/auth";
import type { WorkerConfig } from "../../apps/worker/src/config";
import { executionCommandsInFlight, processExecutionCommands } from "../../apps/worker/src/maintenance/execution-commands";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `95000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const OTHER_ORG = id(2);
const USER = id(3);
const RUNTIME = id(4);
const SECTION = id(5);
const ADA = id(6);
const ROOMS = ["happy", "busy", "replay", "takeover", "exhausted", "shutdown", "cancel", "raced", "recovered", "lateCancel", "failCancel", "handback", "superseded", "exhaustedCancel", "exhaustedWritten", "racedInherited", "exhaustedOrphan", "exhaustedCancelled"] as const;
type Room = (typeof ROOMS)[number];
const T = Object.fromEntries(ROOMS.map((name, index) => [name, id(100 + index)])) as Record<Room, string>;
const KEY = id(900);
const long = "x".repeat(20_000);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Hermes = {
  client: CommandHermes;
  created: Array<{ idempotencyKey?: string | null; model?: string | null }>;
  profiles: Array<string | null>;
  stopped: string[];
};

/** A fake summarizer: completes at once, or never (`hang`) until its signal aborts. */
function hermes(
  mode: "complete" | "hang" = "complete",
  onStop?: (runId: string) => Promise<void>,
): Hermes & { factory: typeof createRuntimeClient } {
  const created: Hermes["created"] = [];
  const profiles: Hermes["profiles"] = [];
  const stopped: string[] = [];
  const client: CommandHermes = {
    stopRun: async (runId) => { await onStop?.(runId); stopped.push(runId); },
    ensureSession: async () => undefined,
    createRun: async (input) => {
      created.push({ idempotencyKey: input.idempotencyKey, model: input.model });
      return `hermes-${created.length}`;
    },
    getRunStatus: async (runId) => ({
      id: runId, status: mode === "complete" ? "completed" : "running", output: "# Room state\n- launch planned", error: null,
    }) as never,
  };
  const factory = ((context: { hermesProfile: string | null }) => {
    profiles.push(context.hermesProfile);
    return client;
  }) as unknown as typeof createRuntimeClient;
  return { client, created, profiles, stopped, factory };
}

await withDisposablePostgres("openedbot5_s3_commands", async ({ owner, connect }) => {
  await owner`insert into users (id, email) values (${USER}, 's3-commands@example.test')`;
  for (const org of [ORG, OTHER_ORG]) {
    await owner`insert into organizations (id, slug, name) values (${org}, ${`s3-${org.slice(-4)}`}, 's3')`;
  }
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
  await owner`insert into operator_profiles (organization_id, username) values (${ORG}, 'camille')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'S3', 0)`;
  const linkHash = new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex");
  await owner`insert into runtimes (id, organization_id, name, reachability, is_active, capacity, link_last_seen_at, link_token_hash,
                                    selected_provider, selected_model)
    values (${RUNTIME}, ${ORG}, 'Connector', 'connector', true, 4, now(), ${linkHash}, 'anthropic', 'claude-sonnet-5')`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position, hermes_profile, model)
    values (${ADA}, ${ORG}, ${SECTION}, 'Ada', 'ada', 0, 'ada', 'gpt-5.6-luna')`;
  await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${id(99)}, ${ORG}, ${ADA}, 'DM', 's3-dm', true)`;
  for (const [index, room] of ROOMS.entries()) {
    // One room per scenario: a group has one thread.
    const group = id(200 + index);
    await owner`insert into bot_groups (id, organization_id, section_id, name, position) values (${group}, ${ORG}, ${SECTION}, ${room}, ${index})`;
    await owner`insert into group_members (organization_id, group_id, bot_id, position) values (${ORG}, ${group}, ${ADA}, 0)`;
    await owner`insert into threads (id, organization_id, group_id, title, hermes_session_id)
      values (${T[room]}, ${ORG}, ${group}, ${room}, ${`s3-${room}`})`;
    const lines: Array<[string, string, string | null]> = [
      ["user", "Plan the launch", null], ["assistant", "Draft ready", ADA], ["user", long, null], ["assistant", long, ADA],
    ];
    for (const [role, text, author] of lines) {
      await owner`insert into messages (id, organization_id, thread_id, role, content, author_bot_id)
        values (${crypto.randomUUID()}, ${ORG}, ${T[room]}, ${role}, ${[{ type: "text", text }]}, ${author})`;
    }
  }

  const api = await connect("openedbot_api");
  const workerA = await connect("openedbot_worker");
  const workerB = await connect("openedbot_worker");
  const config = (workerId: string) => ({ workerId }) as unknown as WorkerConfig;
  const links: RuntimeLinks = {
    connected: () => true,
    dial: () => () => Promise.reject(new Error("unused")),
    revoke: () => false,
    notifyRotation: () => false,
    close: () => false,
  };
  const auth: AuthContext = { sessionId: "s", organizationId: ORG, userId: USER, role: "owner", kind: "web", credentialHash: "h" };
  const app = (waitMs = 20_000) => {
    const routes = new Hono<{ Variables: AppVariables }>();
    routes.use("*", async (context, next) => { context.set("auth", auth); await next(); });
    routes.onError((error, context) => error instanceof HttpError
      ? context.json({ error: { code: error.code } }, error.status as 400)
      : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
    routes.route("/", threadCompactRoutes(api as never, { billingEnforced: false } as ApiConfig, {
      links, locator: { locate: async () => ({ kind: "local" }) } as never, waitMs,
    }));
    return routes;
  };
  const post = (room: Room, options: { key?: string; waitMs?: number } = {}) => app(options.waitMs).request(`/${T[room]}/compact`, {
    method: "POST", headers: options.key ? { "Idempotency-Key": options.key } : {},
  });
  const command = async (room: Room) => (await owner<Array<{
    id: string; status: string; attempts: number; generation: number; errorCode: string | null; leaseOwner: string | null;
  }>>`
    select id, status, attempts, lease_generation::int as generation, error_code as "errorCode", lease_owner as "leaseOwner"
      from execution_commands where thread_id = ${T[room]} order by created_at desc limit 1`)[0];
  const watermark = async (room: Room) => (await owner<Array<{ through: number }>>`
    select compacted_through_sequence as through from thread_compactions where thread_id = ${T[room]}`)[0]?.through ?? null;
  const work = async (db: SQL, workerId: string, fake: ReturnType<typeof hermes>, signal = new AbortController().signal) => {
    await processExecutionCommands(db, config(workerId), signal, undefined, fake.factory);
    await executionCommandsInFlight();
  };
  const proof: Record<string, unknown> = {};

  // 1. Happy path.
  {
    const fake = hermes();
    const pending = post("happy");
    let row = await command("happy");
    for (let i = 0; i < 50 && !row; i++) { await Bun.sleep(20); row = await command("happy"); }
    assert(row?.status === "queued", `the API records a queued command (got ${JSON.stringify(row)})`);
    await work(workerA, "s3-worker-a", fake);
    const response = await pending;
    const body = await response.json() as Record<string, unknown>;
    assert(response.status === 200 && body.compacted === true && body.summarizedCount === 3, `the request answers the worker's result (got ${response.status} ${JSON.stringify(body)})`);
    assert(fake.profiles[0] === "ada", `the summary runs on the last speaker's profile (got ${fake.profiles[0]})`);
    assert(fake.created[0]?.model === "gpt-5.6-luna", `with the member's own model (got ${fake.created[0]?.model})`);
    const settled = await command("happy");
    assert(settled?.status === "succeeded" && settled.attempts === 1 && settled.leaseOwner === null, `one attempt, lease released (got ${JSON.stringify(settled)})`);
    const through = await watermark("happy");
    assert(through !== null && body.compactedThroughSequence === through, `the summary is written up to the last folded message (got ${through})`);
    assert(fake.created[0]?.idempotencyKey === `compact:${settled.id}:${through}`, `the Hermes run is keyed by the command (got ${fake.created[0]?.idempotencyKey})`);
    proof.happy = { status: response.status, summarizedCount: body.summarizedCount, attempts: settled.attempts };
  }

  // 2. One active command per thread; an unclaimed one is withdrawn at the deadline.
  {
    const first = post("busy", { waitMs: 600 });
    await Bun.sleep(150);
    const second = await post("busy");
    assert(second.status === 409, `a second request is refused while the first is active (got ${second.status})`);
    assert((await second.json() as { error: { code: string } }).error.code === "COMPACTION_IN_PROGRESS", "with COMPACTION_IN_PROGRESS");
    const timedOut = await first;
    assert(timedOut.status === 503, `no worker claimed it: 503 (got ${timedOut.status})`);
    const withdrawn = await command("busy");
    assert(withdrawn?.status === "cancelled" && withdrawn.errorCode === "COMMAND_NOT_STARTED", `withdrawn (got ${JSON.stringify(withdrawn)})`);
    const late = hermes();
    await work(workerA, "s3-worker-a", late);
    assert(late.created.length === 0 && await watermark("busy") === null, "a worker back later does not run it");
    proof.busy = { second: 409, first: 503, withdrawn: withdrawn.errorCode };
  }

  // 3. The API goes away between recording and pickup; the replay finds the result.
  {
    const recorded = await submitThreadCompaction(api as never, {
      organizationId: ORG, threadId: T.replay, runtimeId: RUNTIME, userId: USER, idempotencyKey: KEY,
    });
    assert(recorded.command.status === "queued" && !recorded.replayed, "recorded without anyone waiting");
    // The same key, twice at once on two connections: one command, one replay.
    const apiB = await connect("openedbot_api");
    const twin = id(901);
    const both = await Promise.all([api, apiB].map((db) => submitThreadCompaction(db as never, {
      organizationId: ORG, threadId: T.busy, runtimeId: RUNTIME, userId: USER, idempotencyKey: twin,
    })));
    const [one, two] = both as [typeof both[number], typeof both[number]];
    assert(one.command.id === two.command.id && both.filter((entry) => entry.replayed).length === 1,
      `concurrent submits under one key record one command (got ${JSON.stringify(both.map((entry) => [entry.command.id, entry.replayed]))})`);
    await owner`update execution_commands set status = 'cancelled', error_code = 'COMMAND_CANCELLED', finished_at = now()
      where id = ${one.command.id}`;
    const fake = hermes();
    await work(workerB, "s3-worker-b", fake);
    assert((await command("replay"))?.status === "succeeded", "a later worker executes it");
    const replay = await post("replay", { key: KEY });
    const body = await replay.json() as Record<string, unknown>;
    assert(replay.status === 200 && replay.headers.get("Idempotency-Replayed") === "true" && body.summarizedCount === 3,
      `the replay returns the recorded result (got ${replay.status} ${JSON.stringify(body)})`);
    assert(fake.created.length === 1, "and no second summary");
    proof.replay = { status: replay.status, replayed: true, hermesRuns: fake.created.length };
  }

  // 4. Worker A dies mid-command; B takes it over; A is fenced. Spent attempts fail.
  {
    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.takeover, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    const claimedA = await claimNextExecutionCommand(workerA, "s3-worker-a");
    assert(claimedA?.threadId === T.takeover && claimedA.leaseGeneration === 1 && claimedA.attempts === 1, `A claims (got ${JSON.stringify(claimedA)})`);
    assert(await claimNextExecutionCommand(workerB, "s3-worker-b") === null, "B finds nothing while A's lease is live");
    await owner`update execution_commands set lease_expires_at = now() - interval '1 second' where id = ${claimedA.id}`;
    assert(await renewCommandLease(workerA, claimedA, 60) === null, "A's expired lease is not renewed");
    const claimedB = await claimNextExecutionCommand(workerB, "s3-worker-b");
    assert(claimedB?.id === claimedA.id && claimedB.leaseGeneration === 2 && claimedB.attempts === 2, `B takes it over (got ${JSON.stringify(claimedB)})`);
    assert(!(await finishExecutionCommand(workerA, claimedA, { status: "failed", errorCode: "COMPACTION_FAILED" })), "A cannot settle it");
    // A wakes up and runs its summary anyway: the write is fenced, nothing lands.
    const stale = hermes();
    await executeExecutionCommand(workerA, claimedA, { client: () => stale.client, signal: new AbortController().signal });
    assert(stale.created.length === 1 && await watermark("takeover") === null, "the stale worker's summary is not written");
    assert((await command("takeover"))?.leaseOwner === "s3-worker-b", "nor does it touch B's lease");
    const fake = hermes();
    await executeExecutionCommand(workerB, claimedB, { client: () => fake.client, signal: new AbortController().signal });
    const settled = await command("takeover");
    assert(settled?.status === "succeeded" && settled.generation === 2, `B settles it (got ${JSON.stringify(settled)})`);

    // A summary written (with its progress) by a worker that died before settling.
    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.recovered, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    const dying = await claimNextExecutionCommand(workerA, "s3-worker-a");
    assert(dying?.threadId === T.recovered, "claimed by the worker about to die");
    const crash = hermes();
    await executeExecutionCommand(workerA, dying, {
      client: () => crash.client,
      signal: new AbortController().signal,
      compact: async (...args) => {
        const { compactThreadNow } = await import("../../modules/conversation/src/application/compact-thread");
        await compactThreadNow(...args);
        // The process dies here, after the summary, before the settlement.
        await owner`update execution_commands set lease_expires_at = now() - interval '1 second' where id = ${dying.id}`;
        return { compacted: true, summarizedCount: 0, compactedThroughSequence: null };
      },
    });
    assert(await watermark("recovered") !== null && (await command("recovered"))?.status === "running", "summary written, command unsettled");
    const recovering = await claimNextExecutionCommand(workerB, "s3-worker-b");
    const second = hermes();
    await executeExecutionCommand(workerB, recovering!, { client: () => second.client, signal: new AbortController().signal });
    const recovered = (await owner<Array<{ status: string; result: { summarizedCount: number } | null }>>`
      select status, result from execution_commands where thread_id = ${T.recovered}`)[0];
    assert(recovered?.status === "succeeded" && recovered.result?.summarizedCount === 3 && second.created.length === 0,
      `the next attempt settles the recorded work without a second summary (got ${JSON.stringify(recovered)})`);

    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.exhausted, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    await owner`update execution_commands set status = 'running', attempts = 3, lease_owner = 'dead', lease_generation = 3,
      lease_expires_at = now() - interval '1 second', started_at = now() where thread_id = ${T.exhausted}`;
    const none = hermes();
    await work(workerA, "s3-worker-a", none);
    const exhausted = await command("exhausted");
    assert(exhausted?.status === "failed" && exhausted.errorCode === "COMMAND_ATTEMPTS_EXHAUSTED" && none.created.length === 0,
      `spent attempts fail the command without running it (got ${JSON.stringify(exhausted)})`);
    // Spent attempts, cancelled after the last worker died, no run on the host: cancelled, not failed.
    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.exhaustedCancelled, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    await owner`update execution_commands set status = 'running', attempts = 3, lease_owner = 'dead', lease_generation = 3,
      lease_expires_at = now() - interval '1 second', started_at = now(), cancel_requested_at = now()
      where thread_id = ${T.exhaustedCancelled}`;
    const reaper = hermes();
    await work(workerA, "s3-worker-a", reaper);
    const exhaustedCancelled = await command("exhaustedCancelled");
    assert(exhaustedCancelled?.status === "cancelled" && exhaustedCancelled.errorCode === "COMMAND_CANCELLED" && reaper.created.length === 0,
      `an accepted cancellation settles as one (got ${JSON.stringify(exhaustedCancelled)})`);
    // Spent attempts with a summary run left on the host: claimed once more to stop it, then failed.
    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.exhaustedOrphan, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    await owner`update execution_commands set status = 'running', attempts = 3, lease_owner = 'dead', lease_generation = 3,
      lease_expires_at = now() - interval '1 second', started_at = now(),
      hermes_run = '{"id": "orphan-summary", "profile": "ada"}'::jsonb where thread_id = ${T.exhaustedOrphan}`;
    const sweeper = hermes();
    await work(workerA, "s3-worker-a", sweeper);
    const exhaustedOrphan = await command("exhaustedOrphan");
    assert(exhaustedOrphan?.status === "failed" && exhaustedOrphan.errorCode === "COMMAND_ATTEMPTS_EXHAUSTED"
      && sweeper.stopped[0] === "orphan-summary" && sweeper.created.length === 0,
      `the orphan run is stopped, then the command failed (got ${JSON.stringify(exhaustedOrphan)}, stopped ${JSON.stringify(sweeper.stopped)})`);
    // The last attempt wrote its summary and died before settling: that work is the result.
    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.exhaustedWritten, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    await owner`update execution_commands set status = 'running', attempts = 3, lease_owner = 'dead', lease_generation = 3,
      lease_expires_at = now() - interval '1 second', started_at = now(),
      progress = '{"summarizedCount": 4, "compactedThroughSequence": 4, "compactedAt": "2026-11-06T10:00:00.000Z"}'::jsonb
      where thread_id = ${T.exhaustedWritten}`;
    const idle = hermes();
    await work(workerA, "s3-worker-a", idle);
    const exhaustedWritten = (await owner<Array<{ status: string; result: { summarizedCount: number } | null }>>`
      select status, result from execution_commands where thread_id = ${T.exhaustedWritten}`)[0];
    assert(exhaustedWritten?.status === "succeeded" && exhaustedWritten.result?.summarizedCount === 4
      && idle.created.length === 0,
      `spent attempts with recorded work settle it as the result (got ${JSON.stringify(exhaustedWritten)})`);
    // A pending cancellation past the attempts: claimed once more to stop the host run.
    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.exhaustedCancel, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    await owner`update execution_commands set status = 'running', attempts = 3, lease_owner = 'dead', lease_generation = 3,
      lease_expires_at = now() - interval '1 second', started_at = now(), cancel_requested_at = now(),
      hermes_run = '{"id": "orphan-run", "profile": "ada"}'::jsonb where thread_id = ${T.exhaustedCancel}`;
    const cleaner = hermes();
    await work(workerA, "s3-worker-a", cleaner);
    const exhaustedCancel = await command("exhaustedCancel");
    assert(exhaustedCancel?.status === "cancelled" && cleaner.stopped[0] === "orphan-run" && cleaner.created.length === 0,
      `the host run is stopped, then the command cancelled (got ${JSON.stringify(exhaustedCancel)}, stopped ${JSON.stringify(cleaner.stopped)})`);

    // A retry whose earlier run cannot be reused (its key moved): that run is stopped.
    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.superseded, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    await owner`update execution_commands set started_at = now(), attempts = 0,
      hermes_run = '{"id": "earlier-run", "profile": "ada"}'::jsonb where thread_id = ${T.superseded}`;
    // Its handle stays recorded until it is stopped: a worker dying in between leaves it to the next attempt.
    const handleAtStop: Array<string | null> = [];
    const replacement = hermes("complete", async () => {
      handleAtStop.push((await owner<Array<{ run: string | null }>>`
        select hermes_run ->> 'id' as run from execution_commands where thread_id = ${T.superseded}`)[0]?.run ?? null);
    });
    await work(workerB, "s3-worker-b", replacement);
    const superseded = await command("superseded");
    const replacedBy = (await owner<Array<{ run: string | null }>>`
      select hermes_run ->> 'id' as run from execution_commands where thread_id = ${T.superseded}`)[0]?.run;
    assert(superseded?.status === "succeeded" && replacement.stopped[0] === "earlier-run" && replacement.created.length === 1
      && handleAtStop[0] === "earlier-run" && replacedBy === "hermes-1",
      `the earlier run is stopped before its handle is replaced (got ${JSON.stringify(superseded)}, stopped ${JSON.stringify(replacement.stopped)}, handle at stop ${JSON.stringify(handleAtStop)}, then ${replacedBy})`);

    proof.takeover = {
      generations: [claimedA.leaseGeneration, claimedB.leaseGeneration], staleWritesRefused: true,
      recoveredAfterCrash: recovered.status, exhausted: exhausted.errorCode,
      exhaustedWithCancel: exhaustedCancel.status, exhaustedWithWork: exhaustedWritten.status, exhaustedWithRun: "stopped", superseded: "stopped",
    };
  }

  // 5. A graceful stop hands the running command back.
  {
    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.shutdown, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    const stopping = new AbortController();
    const hanging = hermes("hang");
    const claimed = await claimNextExecutionCommand(workerA, "s3-worker-a");
    assert(claimed?.threadId === T.shutdown, "claimed");
    const execution = executeExecutionCommand(workerA, claimed, { client: () => hanging.client, signal: stopping.signal });
    await Bun.sleep(200);
    stopping.abort("SIGTERM");
    await execution;
    assert(hanging.stopped.length === 0, "a shutdown leaves the summary run for the next attempt");
    const released = await command("shutdown");
    assert(released?.status === "queued" && released.attempts === 0 && released.leaseOwner === null, `handed back, attempt not counted (got ${JSON.stringify(released)})`);
    // Old enough for the queue expiry and past a request's deadline: still kept.
    await owner`update execution_commands set created_at = now() - interval '10 minutes' where id = ${released.id}`;
    const waited = await awaitExecutionCommand(api as never, ORG, released.id, { deadlineMs: 0 });
    assert(waited?.status === "queued", `a handed-back command is not withdrawn at a request's deadline (got ${waited?.status})`);
    await work(workerB, "s3-worker-b", hermes());
    assert((await command("shutdown"))?.status === "succeeded", "the next worker finishes it");
    proof.shutdown = { released: "queued", then: "succeeded" };
  }

  // 6. Cancellation, queued then running.
  {
    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.cancel, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    const queuedCancel = await app().request(`/${T.cancel}/compact`, { method: "DELETE" });
    const cancelledQueued = await command("cancel");
    assert(queuedCancel.status === 204 && cancelledQueued?.status === "cancelled" && cancelledQueued.errorCode === "COMMAND_CANCELLED",
      `a queued command is cancelled at once (got ${queuedCancel.status} ${JSON.stringify(cancelledQueued)})`);
    assert((await app().request(`/${T.cancel}/compact`, { method: "DELETE" })).status === 404, "nothing left to cancel");

    const hanging = hermes("hang");
    const pending = post("cancel");
    let claimed = null;
    for (let i = 0; i < 50 && !claimed; i++) { await Bun.sleep(20); claimed = await claimNextExecutionCommand(workerA, "s3-worker-a"); }
    assert(claimed?.threadId === T.cancel, "the second request's command is claimed");
    const execution = executeExecutionCommand(workerA, claimed, { client: () => hanging.client, signal: new AbortController().signal, heartbeatMs: 50 });
    await Bun.sleep(150);
    assert((await app().request(`/${T.cancel}/compact`, { method: "DELETE" })).status === 204, "the running command is asked to stop");
    await execution;
    const response = await pending;
    assert(response.status === 409 && (await response.json() as { error: { code: string } }).error.code === "COMPACTION_CANCELLED",
      "the waiting request answers COMPACTION_CANCELLED");
    assert((await command("cancel"))?.status === "cancelled", "the running command is cancelled by its heartbeat");
    assert(hanging.stopped.length === 1 && hanging.stopped[0] === "hermes-1", `its summary run is stopped on the host (got ${JSON.stringify(hanging.stopped)})`);

    // Asked between two heartbeats, while the summary completes: nothing is written.
    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.lateCancel, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    const late = await claimNextExecutionCommand(workerA, "s3-worker-a");
    assert(late?.threadId === T.lateCancel, "claimed");
    const quick = hermes();
    const lateClient: CommandHermes = {
      ...quick.client,
      getRunStatus: async (runId, signal) => {
        await owner`update execution_commands set cancel_requested_at = now() where id = ${late.id}`;
        return quick.client.getRunStatus(runId, signal);
      },
    };
    await executeExecutionCommand(workerA, late, { client: () => lateClient, signal: new AbortController().signal, heartbeatMs: 60_000 });
    const lateRow = await command("lateCancel");
    assert(lateRow?.status === "cancelled" && await watermark("lateCancel") === null && quick.stopped.length === 1,
      `a late cancellation wins over the completed summary (got ${JSON.stringify(lateRow)}, stopped ${quick.stopped.length})`);

    // The same, while the status poll fails: cancelled and stopped, not failed.
    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.failCancel, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    const failing = await claimNextExecutionCommand(workerA, "s3-worker-a");
    assert(failing?.threadId === T.failCancel, "claimed");
    const broken = hermes();
    const brokenClient: CommandHermes = {
      ...broken.client,
      getRunStatus: async () => {
        await owner`update execution_commands set cancel_requested_at = now() where id = ${failing.id}`;
        throw new Error("host gone");
      },
    };
    await executeExecutionCommand(workerA, failing, { client: () => brokenClient, signal: new AbortController().signal, heartbeatMs: 60_000 });
    const failRow = await command("failCancel");
    assert(failRow?.status === "cancelled" && broken.stopped.length === 1,
      `a failure after a cancellation settles as cancelled and stops the run (got ${JSON.stringify(failRow)}, stopped ${broken.stopped.length})`);

    // Asked while the command was handed back: the next worker stops the recorded run.
    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.handback, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    const first = await claimNextExecutionCommand(workerA, "s3-worker-a");
    const stopping = new AbortController();
    const stuck = hermes("hang");
    const running = executeExecutionCommand(workerA, first!, { client: () => stuck.client, signal: stopping.signal });
    await Bun.sleep(200);
    stopping.abort("SIGTERM");
    await running;
    assert((await app().request(`/${T.handback}/compact`, { method: "DELETE" })).status === 204, "cancel asked while handed back");
    assert((await command("handback"))?.status === "queued", "kept queued for a worker to stop the remote run");
    const next = hermes();
    await work(workerB, "s3-worker-b", next);
    const handedBack = await command("handback");
    assert(handedBack?.status === "cancelled" && next.stopped[0] === "hermes-1" && next.created.length === 0,
      `the next worker stops the recorded run, then cancels (got ${JSON.stringify(handedBack)}, stopped ${JSON.stringify(next.stopped)})`);
    proof.cancel = { queued: "cancelled", running: "cancelled", betweenHeartbeats: "cancelled", handedBack: "cancelled" };
  }

  // 7. A run starts between the request and the claim: the worker refuses.
  {
    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.raced, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    await owner`insert into runs (id, organization_id, thread_id, bot_id, input, status, step_kind)
      values (${id(500)}, ${ORG}, ${T.raced}, ${ADA}, 'S3', 'queued', 'root')`;
    const fake = hermes();
    await work(workerA, "s3-worker-a", fake);
    const raced = await command("raced");
    assert(raced?.status === "failed" && raced.errorCode === "RUN_IN_PROGRESS" && fake.created.length === 0, `refused (got ${JSON.stringify(raced)})`);
    // Handed back mid-summary, then a turn started: the inherited run is stopped before the refusal.
    await submitThreadCompaction(api as never, { organizationId: ORG, threadId: T.racedInherited, runtimeId: RUNTIME, userId: USER, idempotencyKey: null });
    await owner`update execution_commands set started_at = now(), attempts = 1,
      hermes_run = '{"id": "inherited-run", "profile": "ada"}'::jsonb where thread_id = ${T.racedInherited}`;
    await owner`insert into runs (id, organization_id, thread_id, bot_id, input, status, step_kind)
      values (${id(501)}, ${ORG}, ${T.racedInherited}, ${ADA}, 'S3', 'queued', 'root')`;
    const heir = hermes();
    await work(workerA, "s3-worker-a", heir);
    const racedInherited = await command("racedInherited");
    assert(racedInherited?.status === "failed" && racedInherited.errorCode === "RUN_IN_PROGRESS"
      && heir.stopped[0] === "inherited-run" && heir.created.length === 0,
      `the inherited run is stopped, then the command refused (got ${JSON.stringify(racedInherited)}, stopped ${JSON.stringify(heir.stopped)})`);
    proof.raced = { refused: raced.errorCode, inheritedRun: "stopped" };
  }

  // 8. Tenancy and retention.
  {
    const foreign = await api.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${OTHER_ORG}, true)`;
      return tx<Array<{ id: string }>>`select id from execution_commands`;
    });
    assert(foreign.length === 0, "the API role sees no command of another organization");
    await owner`update execution_commands set finished_at = now() - interval '8 days' where thread_id = ${T.happy}`;
    const purged = await purgeSettledExecutionCommands(workerA, 7);
    assert(purged === 1, `only the settled command past retention is deleted (got ${purged})`);
    proof.tenancy = { foreign: foreign.length, purged };
  }

  console.log(JSON.stringify({ test: "execution-commands", ...proof }));
});
