import { SQL } from "bun";
import { createServer, type Socket } from "node:net";
import { withDisposablePostgres } from "./disposable-postgres";
import { claimRun } from "../../modules/execution/src/application/queue";
import { createWorkerService } from "../../apps/worker/src/application/worker-service";
import type { WorkerConfig } from "../../apps/worker/src/config";
import { createRunQueueNotifications, RUN_QUEUE_CHANNEL } from "../../apps/worker/src/infrastructure/run-queue-notifications";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, limitMs = 3_000): Promise<void> {
  const until = performance.now() + limitMs;
  while (!condition()) { if (performance.now() > until) throw new Error("Timed out waiting for the integration barrier."); await sleep(5); }
}
const ORG = "91210000-0000-4000-8000-000000000001";
const THREAD = "91210000-0000-4000-8000-000000000002";
const BOT = "91210000-0000-4000-8000-000000000003";
const id = (n: number) => `91210000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// LISTEN/NOTIFY needs Bun >= 1.4 (`sql.listen` on a client instance; `SQL` has
// no `prototype` to inspect); the repository pins bun@1.4.0 in package.json.
// Fail at once with the cause rather than on a barrier timeout three seconds
// later. The probe client never connects: Bun opens connections lazily.
{
  const probe = new SQL({ url: "postgres://127.0.0.1:1/probe", max: 1 });
  const hasListen = typeof (probe as { listen?: unknown }).listen === "function";
  await probe.close().catch(() => undefined);
  if (!hasListen) throw new Error(`Bun ${Bun.version} has no sql.listen: this proof needs the pinned Bun 1.4.0 (packageManager).`);
}

await withDisposablePostgres("openedbot121_queue", async ({ owner, url, connect }) => {
  const versions = await owner<Array<{ version: string }>>`select version from schema_migrations where version in
    ('0094_worker_run_queue_notifications', '0095_worker_run_queue_unblock_notifications') order by version`;
  assert(versions.length === 2, "Both notification migrations must commit their version receipts.");
  await owner`insert into organizations (id, slug, name) values (${ORG}, 'openedbot121', 'Queue integration')`;
  await owner`insert into sections (id, organization_id, name, position) values (${id(4)}, ${ORG}, 'Queue', 0)`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position) values (${BOT}, ${ORG}, ${id(4)}, 'Queue', 'queue', 0)`;
  await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${THREAD}, ${ORG}, ${BOT}, 'Queue', 'openedbot121-fixture-session', true)`;
  const linkHash = new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex");
  await owner`insert into runtimes (id, organization_id, name, reachability, is_active, capacity, link_last_seen_at, link_token_hash)
    values (${id(5)}, ${ORG}, 'Fixture connector', 'connector', true, 4, now(), ${linkHash})`;
  const raw = new SQL({ url, max: 1, idleTimeout: 0, connectionTimeout: 2 });
  let ready = 0;
  let notified = 0;
  const listener = createRunQueueNotifications(url, { clientFactory: () => ({
    listen: (channel, onnotify, onlisten) => raw.listen(channel, (payload) => {
      assert(payload === "", "Run notifications must contain no tenant or run data.");
      notified++; onnotify(payload);
    }, () => { ready++; onlisten?.(); }),
    close: (options) => raw.close(options),
  }) });
  listener.start(() => {});
  try {
    await until(() => ready === 1);
    const before = notified;
    await owner.begin(async (tx) => {
      await tx`insert into runs (id, organization_id, thread_id, bot_id, input) values (${id(10)}, ${ORG}, ${THREAD}, ${BOT}, 'fixture')`;
      await sleep(50);
      assert(notified === before, "A queued insert must not notify before commit.");
    });
    await until(() => notified > before);
    const afterCommit = notified;
    const rollback = new Error("intentional rollback");
    try {
      await owner.begin(async (tx) => {
        await tx`insert into runs (id, organization_id, thread_id, bot_id, input) values (${id(11)}, ${ORG}, ${THREAD}, ${BOT}, 'fixture')`;
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
    await sleep(50);
    assert(notified === afterCommit, "A rolled-back insert must not notify.");
    await owner`delete from runs where organization_id = ${ORG}`;
  } finally { await listener.stop(); }

  const db = await connect("openedbot_worker");
  const native = new SQL({ url, max: 1, idleTimeout: 0, connectionTimeout: 2 });
  ready = 0; notified = 0;
  const notifications = createRunQueueNotifications(url, { clientFactory: () => ({
    listen: (channel, onnotify, onlisten) => native.listen(channel, (payload) => {
      assert(payload === "", "Worker hints must have an empty payload.");
      notified++; onnotify(payload);
    }, () => { ready++; onlisten?.(); }),
    close: (options) => native.close(options),
  }) });
  const config = { workerId: "notification-integration", pollMs: 2_000, maxActiveRuns: 1,
    leaseSeconds: 30, routineTickMs: 10_000, healthFile: null } as WorkerConfig;
  let emptyClaims = 0;
  let claimsInFlight = 0;
  const claimed: Array<{ id: string; queuedMs: number; ready: number; notified: number }> = [];
  const worker = createWorkerService(db, config, {
    jobs: [], runQueueNotifications: notifications,
    registry: { recordHeartbeat: async () => undefined, releaseLeasesAndClose: async () => undefined },
    interruptRequestedRuns: async () => 0,
    claimRun: async (...args) => {
      claimsInFlight++;
      try {
        const result = await claimRun(...args);
        if (!result) emptyClaims++;
        return result;
      } finally { claimsInFlight--; }
    },
    executeRun: async (_db, _config, run) => {
      claimed.push({ id: run.id, queuedMs: run.queuedMs!, ready, notified });
      await owner`update runs set status = 'completed', ended_at = now(), lease_owner = null, lease_expires_at = null where id = ${run.id}`;
    },
  });
  const running = worker.run();
  try {
    await until(() => ready === 1 && emptyClaims > 0);
    await owner`insert into runs (id, organization_id, thread_id, bot_id, input) values (${id(20)}, ${ORG}, ${THREAD}, ${BOT}, 'fixture')`;
    await until(() => claimed.length === 1);
    assert(claimed[0]!.queuedMs < 1_000, "The committed row must be claimed without the two-second poll.");
    await until(() => emptyClaims >= 2);
    await until(() => notified >= 2);
    // Drain the completion hint and local capacity wake before forcing the gap.
    // Otherwise an already-running claim can legitimately see the new row
    // before the listener reconnects, which does not prove reconnect catch-up.
    await sleep(100);
    await until(() => claimsInFlight === 0);
    const backends = await owner<Array<{ pid: number }>>`select pid from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and query like 'LISTEN%' and position(${RUN_QUEUE_CHANNEL} in query) > 0`;
    assert(backends.length === 1, "Only this disposable database's single listener may be interrupted.");
    const killed = await owner<Array<{ interrupted: boolean }>>`select pg_terminate_backend(${backends[0]!.pid}) as interrupted`;
    assert(killed[0]?.interrupted === true, "The fixture LISTEN backend must be disconnected.");
    assert(ready === 1, "The disconnected interval must precede resubscription.");
    const deliveredBeforeGap = notified;
    await owner`insert into runs (id, organization_id, thread_id, bot_id, input) values (${id(21)}, ${ORG}, ${THREAD}, ${BOT}, 'fixture')`;
    await until(() => claimed.length === 2);
    assert(claimed[1]!.ready >= 2, "Reconnect ACK must wake the durable catch-up claim.");
    assert(claimed[1]!.notified === deliveredBeforeGap, "The notification sent while disconnected must not be treated as delivered.");
    assert(claimed[1]!.queuedMs < 1_500, "Reconnect catch-up must precede the two-second fallback.");
    assert(claimed.map((run) => run.id).join(",") === [id(20), id(21)].join(","), "The real claim preserves FIFO and does not duplicate rows.");
    const beforeBlockedClaim = emptyClaims;
    await owner`insert into runs (id, organization_id, thread_id, bot_id, input, status, external_state, created_at)
      values (${id(30)}, ${ORG}, ${THREAD}, ${BOT}, 'fixture', 'unknown', 'ambiguous', now() - interval '1 second')`;
    await owner`insert into runs (id, organization_id, thread_id, bot_id, input) values (${id(31)}, ${ORG}, ${THREAD}, ${BOT}, 'fixture')`;
    await until(() => emptyClaims > beforeBlockedClaim);
    await sleep(50);
    assert(claimed.length === 2, "An unknown outcome must keep its queued follower blocked.");
    const released = performance.now();
    await owner`update runs set status = 'completed', external_state = 'settled', ended_at = now() where id = ${id(30)}`;
    await until(() => claimed.length === 3);
    const unblockMs = Math.round(performance.now() - released);
    assert(unblockMs < 1_000 && claimed[2]!.id === id(31), "Reconciling an unknown outcome must wake its FIFO follower before the two-second poll.");
    console.info(JSON.stringify({ event: "openedbot121.notifications.passed", committedOnly: true, rollbackSilent: true,
      hintQueuedMs: claimed[0]!.queuedMs, reconnectQueuedMs: claimed[1]!.queuedMs, unblockMs, readyCount: ready, claimed: claimed.length }));
  } finally { worker.stop("integration-complete"); await running; }
});

// A loopback socket that accepts TCP but never completes the PostgreSQL handshake.
// Stop must close a real Bun LISTEN attempt while it is still connecting.
const sockets = new Set<Socket>();
const server = createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object", "The handshake fixture must have a loopback port.");
const url = new URL(`postgresql://127.0.0.1:${address.port}/fixture`);
url.username = crypto.randomUUID(); url.password = crypto.randomUUID();
const connecting = createRunQueueNotifications(url.toString());
try {
  connecting.start(() => { throw new Error("The silent handshake cannot become ready."); });
  await until(() => sockets.size > 0);
  const started = performance.now();
  await connecting.stop();
  assert(performance.now() - started < 2_500, "Stopping a pending native LISTEN must be bounded.");
  console.info(JSON.stringify({ event: "openedbot121.pending_listen_stop.passed", stopMs: Math.round(performance.now() - started) }));
} finally {
  await connecting.stop();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
