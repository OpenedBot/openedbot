// OHB-139: without LISTEN (Bun 1.3, or a listener still reconnecting), the
// queue probe wakes the real claim loop well before the poll, and two workers
// woken by the same queue change still claim every run exactly once.
import { withDisposablePostgres } from "./disposable-postgres";
import { claimRun, readQueuedRunsSignature } from "../../modules/execution/src/application/queue";
import { createWorkerService } from "../../apps/worker/src/application/worker-service";
import type { WorkerConfig } from "../../apps/worker/src/config";
import { createRunQueueNotifications } from "../../apps/worker/src/infrastructure/run-queue-notifications";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, limitMs = 3_000): Promise<void> {
  const deadline = performance.now() + limitMs;
  while (!condition()) { if (performance.now() > deadline) throw new Error("Timed out waiting for the integration barrier."); await sleep(5); }
}
const ORG = "91390000-0000-4000-8000-000000000001";
const BOT = "91390000-0000-4000-8000-000000000003";
const id = (n: number) => `91390000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const THREADS = [id(100), id(101), id(102)];
const POLL_MS = 2_000;

await withDisposablePostgres("ohb139_probe", async ({ owner, url, connect }) => {
  await owner`insert into organizations (id, slug, name) values (${ORG}, 'ohb139', 'Queue probe')`;
  await owner`insert into sections (id, organization_id, name, position) values (${id(4)}, ${ORG}, 'Queue', 0)`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position) values (${BOT}, ${ORG}, ${id(4)}, 'Queue', 'queue', 0)`;
  for (const [index, thread] of THREADS.entries()) {
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${thread}, ${ORG}, ${BOT}, 'Queue', ${`ohb139-fixture-session-${index}`}, ${index === 0})`;
  }
  const linkHash = new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex");
  await owner`insert into runtimes (id, organization_id, name, reachability, is_active, capacity, link_last_seen_at, link_token_hash)
    values (${id(5)}, ${ORG}, 'Fixture connector', 'connector', true, 8, now(), ${linkHash})`;

  const claims = new Map<string, number>();
  const queued: number[] = [];
  const emptyClaims = { count: 0 };
  const workers = await Promise.all(["probe-worker-a", "probe-worker-b"].map(async (workerId) => {
    const db = await connect("ohb_worker");
    const config = { workerId, pollMs: POLL_MS, maxActiveRuns: 2, leaseSeconds: 30, routineTickMs: 10_000,
      healthFile: null } as WorkerConfig;
    // A client without `listen` is exactly Bun 1.3's SQL: only the probe can hint.
    const notifications = createRunQueueNotifications(url, {
      probe: () => readQueuedRunsSignature(db),
      clientFactory: () => ({ close: async () => undefined }) as never,
    });
    const worker = createWorkerService(db, config, {
      jobs: [], runQueueNotifications: notifications,
      registry: { recordHeartbeat: async () => undefined, releaseLeasesAndClose: async () => undefined },
      interruptRequestedRuns: async () => 0,
      claimRun: async (...args) => {
        const result = await claimRun(...args);
        if (!result) emptyClaims.count++;
        return result;
      },
      executeRun: async (_db, _config, run) => {
        claims.set(run.id, (claims.get(run.id) ?? 0) + 1);
        queued.push(run.queuedMs!);
        await sleep(10);
        await owner`update runs set status = 'completed', ended_at = now(), lease_owner = null, lease_expires_at = null
          where id = ${run.id}`;
      },
    });
    return { worker, running: worker.run() };
  }));

  try {
    // Both loops have run one empty claim and now sleep on the two-second poll.
    await until(() => emptyClaims.count >= 2);
    await sleep(50);
    await owner`insert into runs (id, organization_id, thread_id, bot_id, input) values (${id(10)}, ${ORG}, ${THREADS[0]!}, ${BOT}, 'fixture')`;
    await until(() => claims.size === 1, POLL_MS - 500);
    assert(queued[0]! < 500, `The probe must claim before the ${POLL_MS} ms poll (queuedMs ${queued[0]}).`);

    const burst = Array.from({ length: 9 }, (_, index) => ({ run: id(20 + index), thread: THREADS[index % THREADS.length]! }));
    for (const { run, thread } of burst) {
      await owner`insert into runs (id, organization_id, thread_id, bot_id, input) values (${run}, ${ORG}, ${thread}, ${BOT}, 'fixture')`;
    }
    await until(() => claims.size === 1 + burst.length, 5_000);
    await sleep(100);
    const duplicates = [...claims].filter(([, count]) => count !== 1);
    assert(duplicates.length === 0, "Two probed workers must never claim the same run twice.");
    const [left] = await owner<Array<{ count: number }>>`select count(*)::int as count from runs where status <> 'completed'`;
    assert(left?.count === 0, "Every inserted run must be claimed and completed.");
    console.info(JSON.stringify({ event: "ohb139.queue_probe.passed", firstQueuedMs: Math.round(queued[0]!),
      claimed: claims.size, maxQueuedMs: Math.round(Math.max(...queued)) }));
  } finally {
    for (const { worker } of workers) worker.stop("integration-complete");
    await Promise.all(workers.map(({ running }) => running));
  }
});
