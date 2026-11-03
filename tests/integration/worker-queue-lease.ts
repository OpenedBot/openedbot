// Lease contract of `claimRun` and `reapPoisonRuns` on a real PostgreSQL:
// a claim is exclusive, an expired lease is requeued then reclaimed with a
// new generation, an exhausted run is never reclaimed but reaped, and a lease
// lost during the Hermes create is settled as `unknown`, never retried, and
// while a bot's profile is cloning none of its runs start, greeting included.
import { withDisposablePostgres } from "./disposable-postgres";
import { claimRun, MAX_RUN_ATTEMPTS, reapPoisonRuns } from "../../modules/execution/src/application/queue";
import type { WorkerConfig } from "../../apps/worker/src/config";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const ORG = "91400000-0000-4000-8000-000000000001";
const BOT = "91400000-0000-4000-8000-000000000003";
const id = (n: number) => `91400000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const THREADS = [id(100), id(101), id(102), id(103)];
const config = (workerId: string) => ({ workerId, leaseSeconds: 30, billingEnforced: false } as WorkerConfig);

type RunRow = { status: string; leaseOwner: string | null; attempts: number; leaseGeneration: string; errorCode: string | null; externalState: string };

await withDisposablePostgres("ohb140_lease", async ({ owner, connect }) => {
  await owner`insert into organizations (id, slug, name) values (${ORG}, 'ohb140', 'Queue lease')`;
  await owner`insert into sections (id, organization_id, name, position) values (${id(4)}, ${ORG}, 'Queue', 0)`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position) values (${BOT}, ${ORG}, ${id(4)}, 'Queue', 'queue', 0)`;
  for (const [index, thread] of THREADS.entries()) {
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${thread}, ${ORG}, ${BOT}, 'Queue', ${`ohb140-fixture-session-${index}`}, ${index === 0})`;
  }
  const linkHash = new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex");
  await owner`insert into runtimes (id, organization_id, name, reachability, is_active, capacity, link_last_seen_at, link_token_hash)
    values (${id(5)}, ${ORG}, 'Fixture connector', 'connector', true, 8, now(), ${linkHash})`;
  const read = async (run: string): Promise<RunRow> => {
    const [row] = await owner<RunRow[]>`select status, lease_owner as "leaseOwner", attempts, lease_generation::text as "leaseGeneration",
      error_code as "errorCode", external_state as "externalState" from runs where id = ${run}`;
    assert(row, `run ${run} must exist`);
    return row;
  };
  const insert = (run: string, thread: string) =>
    owner`insert into runs (id, organization_id, thread_id, bot_id, input) values (${run}, ${ORG}, ${thread}, ${BOT}, 'fixture')`;
  const workerA = await connect("ohb_worker");
  const workerB = await connect("ohb_worker");

  // 1. One claim per run, one active run per thread.
  await insert(id(10), THREADS[0]!);
  await insert(id(11), THREADS[0]!);
  const first = await claimRun(workerA, config("worker-a"));
  assert(first?.id === id(10), "the oldest queued run of the thread is claimed first");
  assert(first.leaseGeneration === 1, `first claim carries generation 1 (got ${first.leaseGeneration})`);
  const blocked = await claimRun(workerB, config("worker-b"));
  assert(blocked === null, "a second worker claims nothing while the thread has an active run");
  const claimed = await read(id(10));
  assert(claimed.status === "starting" && claimed.leaseOwner === "worker-a" && claimed.attempts === 1, "the claim records owner and attempt");

  // 2. An expired lease is requeued and reclaimed by another worker with a new generation.
  await owner`update runs set status = 'running', lease_expires_at = now() - interval '1 second' where id = ${id(10)}`;
  const reclaimed = await claimRun(workerB, config("worker-b"));
  assert(reclaimed?.id === id(10), "the expired run is reclaimed before the next queued run of its thread");
  assert(reclaimed.leaseGeneration === 2, `a reclaim bumps the generation (got ${reclaimed.leaseGeneration})`);
  const requeued = await read(id(10));
  assert(requeued.leaseOwner === "worker-b" && requeued.attempts === 2, "the reclaim records the new owner and a second attempt");
  assert(requeued.errorCode === "WORKER_LEASE_EXPIRED", `the lost lease is named on the run (got ${requeued.errorCode})`);

  // 3. A run that exhausted its attempts is never reclaimed; the reaper settles it.
  await owner`update runs set status = 'running', attempts = ${MAX_RUN_ATTEMPTS}, lease_expires_at = now() - interval '1 second' where id = ${id(10)}`;
  const exhausted = await claimRun(workerA, config("worker-a"));
  assert(exhausted === null, `an exhausted run is not reclaimed and still blocks its thread (claimed ${exhausted?.id})`);
  const reaped = await reapPoisonRuns(owner, config("worker-a"));
  assert(reaped === 1, `the reaper settles exactly the exhausted run (got ${reaped})`);
  const poison = await read(id(10));
  assert(!["starting", "running", "awaiting_approval", "queued"].includes(poison.status), `an exhausted run leaves the live states (got ${poison.status})`);
  // The thread's next queued run is now the oldest claimable one: settle it so
  // the ambiguous-create scenario below reads its own run.
  const next = await claimRun(workerA, config("worker-a"));
  assert(next?.id === id(11), `the reaped thread frees its next queued run (got ${next?.id})`);
  await owner`update runs set status = 'completed', ended_at = now(), lease_owner = null, lease_expires_at = null where id = ${id(11)}`;

  // 4. A lease lost during the Hermes create is ambiguous: `unknown`, never requeued.
  await insert(id(20), THREADS[1]!);
  const creating = await claimRun(workerA, config("worker-a"));
  assert(creating?.id === id(20), "the run of the second thread is claimable");
  await owner`update runs set status = 'running', external_state = 'creating', lease_expires_at = now() - interval '1 second' where id = ${id(20)}`;
  const afterAmbiguous = await claimRun(workerB, config("worker-b"));
  assert(afterAmbiguous?.id !== id(20), "an ambiguous create is never reclaimed");
  if (afterAmbiguous) await owner`update runs set status = 'completed', ended_at = now(), lease_owner = null, lease_expires_at = null where id = ${afterAmbiguous.id}`;
  const ambiguous = await read(id(20));
  assert(ambiguous.status === "unknown" && ambiguous.externalState === "ambiguous" && ambiguous.errorCode === "HERMES_CREATE_OUTCOME_UNKNOWN",
    `a lease lost while creating settles as unknown (got ${ambiguous.status}/${ambiguous.externalState}/${ambiguous.errorCode})`);

  // 5. A cloning profile holds every run of its bot, the greeting included:
  // it runs on the bot's own profile once ready. An operator run has origin
  // NULL: the gate must not let it reach Hermes before the profile exists.
  const CLONING = id(6);
  await owner`insert into bots (id, organization_id, section_id, name, slug, position) values (${CLONING}, ${ORG}, ${id(4)}, 'Cloning', 'cloning', 1)`;
  await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${id(104)}, ${ORG}, ${CLONING}, 'Cloning', 'ohb140-fixture-session-cloning', true)`;
  await owner`insert into bot_profile_provisions (bot_id, organization_id, runtime_id, slug, display_name, status)
    values (${CLONING}, ${ORG}, ${id(5)}, 'cloning', 'Cloning', 'running')`;
  await owner`insert into runs (id, organization_id, thread_id, bot_id, input) values (${id(30)}, ${ORG}, ${id(104)}, ${CLONING}, 'operator answer')`;
  const held = await claimRun(workerA, config("worker-a"));
  assert(held?.id !== id(30), `an operator run waits for the profile clone (claimed ${held?.id})`);
  if (held) await owner`update runs set status = 'completed', ended_at = now(), lease_owner = null, lease_expires_at = null where id = ${held.id}`;
  await owner`delete from runs where id = ${id(30)}`;
  await owner`insert into runs (id, organization_id, thread_id, bot_id, input, origin) values (${id(31)}, ${ORG}, ${id(104)}, ${CLONING}, 'greeting', 'bot_greeting')`;
  const heldGreeting = await claimRun(workerA, config("worker-a"));
  assert(heldGreeting?.id !== id(31), `the greeting waits for the profile clone (claimed ${heldGreeting?.id})`);
  if (heldGreeting) await owner`update runs set status = 'completed', ended_at = now(), lease_owner = null, lease_expires_at = null where id = ${heldGreeting.id}`;
  await owner`update bot_profile_provisions set status = 'succeeded' where bot_id = ${CLONING}`;
  const greeting = await claimRun(workerA, config("worker-a"));
  assert(greeting?.id === id(31), `the greeting starts once the profile is ready (claimed ${greeting?.id})`);

  console.info(JSON.stringify({ test: "worker-queue-lease", passed: true, exclusiveClaim: true, expiredLeaseReclaimed: true, poisonReaped: reaped, ambiguousCreateSettled: true, cloneHoldsOperatorRuns: true }));
});
