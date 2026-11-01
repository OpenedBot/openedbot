import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { SQL } from "bun";
import type { ClaimedRun } from "@openedbot/execution/application/queue";
import type { TransactionalEmailSender } from "@openedbot/notifications/application/email";
import type { WorkerConfig } from "../src/config";
import type { BackgroundJob } from "../src/application/background-jobs";
import { maintenanceJobs } from "../src/application/maintenance-jobs";
import { createWorkerService, type WorkerServiceDependencies } from "../src/application/worker-service";
import { createRunQueueNotifications } from "../src/infrastructure/run-queue-notifications";

const db = (() => { throw new Error("the worker loop must not query the database itself"); }) as unknown as SQL;
const config = {
  workerId: "worker-test",
  pollMs: 10,
  routineTickMs: 20,
  maxActiveRuns: 4,
  linkQueueTimeoutMs: 900_000,
  transactionalEmail: {},
} as unknown as WorkerConfig;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await sleep(5);
  }
}

/** A queue whose `queuedMs` is the fake insert → claim gap, like PostgreSQL's clock does. */
function fakeQueue() {
  const pending: Array<{ id: string; insertedAt: number }> = [];
  const claimed: ClaimedRun[] = [];
  const claimRun: WorkerServiceDependencies["claimRun"] = async () => {
    const next = pending.shift();
    if (!next) return null;
    const run = {
      id: next.id,
      organizationId: "org-1",
      leaseGeneration: 1,
      queuedMs: performance.now() - next.insertedAt,
    };
    claimed.push(run);
    return run;
  };
  return { claimed, claimRun, insert: (id: string) => pending.push({ id, insertedAt: performance.now() }) };
}

function fakeDependencies(jobs: BackgroundJob[], order: string[] = []) {
  const queue = fakeQueue();
  const dependencies: Partial<WorkerServiceDependencies> = {
    claimRun: queue.claimRun,
    executeRun: async () => undefined,
    interruptRequestedRuns: async () => 0,
    registry: {
      recordHeartbeat: async () => undefined,
      releaseLeasesAndClose: async () => { order.push("leases_released"); },
    },
    jobs,
  };
  return { queue, dependencies };
}

describe("worker claim loop", () => {
  beforeEach(() => {
    spyOn(console, "info").mockImplementation(() => undefined);
    spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    (console.info as unknown as { mockRestore(): void }).mockRestore();
    (console.error as unknown as { mockRestore(): void }).mockRestore();
  });

  for (const jobName of ["email-outbox", "push-notifications"]) test(`a held ${jobName} never delays the next claim, and shutdown still waits for it`, async () => {
    const order: string[] = [];
    const sending = deferred();
    const release = deferred();
    let sends = 0;
    const slowSend: BackgroundJob = {
      name: jobName,
      everyMs: config.routineTickMs,
      run: async () => {
        sends += 1;
        sending.resolve();
        await Promise.race([sleep(5_000), release.promise]);
        order.push("send_finished");
      },
    };
    const { queue, dependencies } = fakeDependencies([slowSend], order);
    const worker = createWorkerService(db, config, dependencies);
    let stopped = false;
    const running = worker.run().then(() => { stopped = true; });

    await sending.promise;
    queue.insert("run-1");
    await until(() => queue.claimed.length === 1);
    queue.insert("run-2");
    await until(() => queue.claimed.length === 2);

    for (const run of queue.claimed) expect(run.queuedMs!).toBeLessThan(250);
    expect(queue.claimed.map((run) => run.id)).toEqual(["run-1", "run-2"]);
    // Single-flight: a send still in flight is never started twice.
    await sleep(config.routineTickMs * 3);
    expect(sends).toBe(1);

    worker.stop("SIGTERM");
    await sleep(config.pollMs * 3);
    expect(stopped).toBe(false);
    release.resolve();
    await running;
    expect(order).toEqual(["send_finished", "leases_released"]);
  });

  test("stop aborts an active run and waits for its cleanup before releasing leases", async () => {
    const order: string[] = [];
    const release = deferred();
    const { queue, dependencies } = fakeDependencies([], order);
    let runSignal: AbortSignal | undefined;
    dependencies.executeRun = async (_db, _config, _run, signal) => {
      runSignal = signal;
      await release.promise;
      order.push("run_cleaned");
    };
    const worker = createWorkerService(db, config, dependencies);
    queue.insert("run-1");
    let stopped = false;
    const running = worker.run().then(() => { stopped = true; });
    try {
      await until(() => runSignal !== undefined);
      worker.stop("SIGTERM");
      expect(runSignal?.aborted).toBe(true);
      await sleep(config.pollMs * 3);
      expect(stopped).toBe(false);
      expect(order).toEqual([]);
    } finally {
      worker.stop("SIGTERM");
      release.resolve();
      await running;
    }
    expect(order).toEqual(["run_cleaned", "leases_released"]);
  });

  test("a queue hint claims a new run without waiting for a two-second poll", async () => {
    const order: string[] = [];
    const { queue, dependencies } = fakeDependencies([], order);
    let claimAttempts = 0;
    dependencies.claimRun = async (...args) => { claimAttempts++; return queue.claimRun(...args); };
    let notify!: () => void;
    dependencies.runQueueNotifications = {
      start: (wake) => { notify = wake; },
      stop: async () => { order.push("listener_closed"); },
    };
    const worker = createWorkerService(db, { ...config, pollMs: 2_000 }, dependencies);
    const running = worker.run();
    try {
      await until(() => claimAttempts > 0);
      queue.insert("notified-run");
      notify();
      await until(() => queue.claimed.length === 1);
      expect(queue.claimed[0]!.queuedMs!).toBeLessThan(250);
    } finally {
      worker.stop("SIGTERM");
      await running;
    }
    expect(order).toEqual(["listener_closed", "leases_released"]);
  });

  test("without LISTEN, the queue probe claims a new run long before the poll", async () => {
    const { queue, dependencies } = fakeDependencies([]);
    let inserted = 0;
    let claimAttempts = 0;
    dependencies.claimRun = async (...args) => { claimAttempts++; return queue.claimRun(...args); };
    // Bun 1.3: the SQL client has no `listen`, so only the probe can hint.
    dependencies.runQueueNotifications = createRunQueueNotifications("fixture-private-url", {
      probeMs: 5,
      probe: async () => `${inserted}`,
      clientFactory: () => ({ close: async () => undefined }) as never,
    });
    const worker = createWorkerService(db, { ...config, pollMs: 2_000 }, dependencies);
    const running = worker.run();
    try {
      await until(() => claimAttempts > 0);
      await sleep(20);
      queue.insert("probed-run");
      inserted++;
      await until(() => queue.claimed.length === 1);
      expect(queue.claimed[0]!.queuedMs!).toBeLessThan(250);
    } finally {
      worker.stop("SIGTERM");
      await running;
    }
  });

  test("a missed wake is still claimed by the poll", async () => {
    const { queue, dependencies } = fakeDependencies([]);
    let claimAttempts = 0;
    dependencies.claimRun = async (...args) => {
      claimAttempts += 1;
      return queue.claimRun(...args);
    };
    const worker = createWorkerService(db, { ...config, pollMs: 40 }, dependencies);
    const running = worker.run();
    try {
      await until(() => claimAttempts > 0);
      queue.insert("missed-wake");
      await until(() => queue.claimed.length === 1, 1_000);
      expect(queue.claimed[0]!.id).toBe("missed-wake");
      expect(queue.claimed[0]!.queuedMs!).toBeLessThan(1_000);
    } finally {
      worker.stop("SIGTERM");
      await running;
    }
  });

  test("finishing a run wakes capacity for an already queued run", async () => {
    const release = deferred();
    const { queue, dependencies } = fakeDependencies([]);
    let executeCount = 0;
    dependencies.executeRun = async () => { if (executeCount++ === 0) await release.promise; };
    queue.insert("first-run");
    const worker = createWorkerService(db, { ...config, pollMs: 2_000, maxActiveRuns: 1 }, dependencies);
    const running = worker.run();
    try {
      await until(() => queue.claimed.length === 1);
      queue.insert("waiting-run");
      release.resolve();
      await until(() => queue.claimed.length === 2);
      expect(queue.claimed.map((run) => run.id)).toEqual(["first-run", "waiting-run"]);
      expect(queue.claimed[1]!.queuedMs!).toBeLessThan(250);
    } finally {
      worker.stop("SIGTERM");
      release.resolve();
      await running;
    }
  });

  test("a failing maintenance pass is logged and the loop keeps claiming", async () => {
    const failing: BackgroundJob = {
      name: "push-notifications",
      everyMs: 1,
      run: async () => { throw new Error("push provider down"); },
    };
    const { queue, dependencies } = fakeDependencies([failing]);
    const worker = createWorkerService(db, config, dependencies);
    const running = worker.run();

    queue.insert("run-1");
    await until(() => queue.claimed.length === 1);
    worker.stop("SIGTERM");
    await running;

    expect(queue.claimed[0]!.queuedMs!).toBeLessThan(250);
    const failures = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([line]) => JSON.parse(String(line)) as { event: string; job?: string });
    expect(failures).toContainEqual(expect.objectContaining({ event: "worker.job_failed", job: "push-notifications" }));
  });

  test("a rejected tracked execution does not create an unhandled cleanup promise", async () => {
    const { queue, dependencies } = fakeDependencies([]);
    dependencies.executeRun = async () => { throw new Error("runner failed"); };
    // A failed output sink can also reject the runner's error handler.
    (console.error as unknown as { mockImplementationOnce(callback: () => never): void })
      .mockImplementationOnce(() => { throw new Error("output sink closed"); });
    queue.insert("run-1"); queue.insert("run-2");
    const worker = createWorkerService(db, config, dependencies);
    const running = worker.run();
    try { await until(() => queue.claimed.length === 2); }
    finally { worker.stop("SIGTERM"); await running; }
    expect(queue.claimed.map((run) => run.id)).toEqual(["run-1", "run-2"]);
  });

  test("shutdown waits for an in-flight metrics heartbeat before closing the registry", async () => {
    const order: string[] = [];
    const release = deferred();
    const inFlight = deferred();
    const { dependencies } = fakeDependencies([], order);
    let heartbeats = 0;
    dependencies.registry!.recordHeartbeat = async () => {
      if (++heartbeats === 1) return;
      inFlight.resolve();
      await release.promise;
      order.push("heartbeat_finished");
    };
    const worker = createWorkerService(db, config, dependencies);
    const running = worker.run();
    try {
      await inFlight.promise;
      worker.stop("SIGTERM");
      await sleep(30);
      expect(order).toEqual([]);
    } finally { worker.stop("SIGTERM"); release.resolve(); await running; }
    expect(order).toEqual(["heartbeat_finished", "leases_released"]);
  }, 10_000);

  test("e-mail and push each run on their own job, apart from the database passes", () => {
    const sender = { send: async () => undefined } as unknown as TransactionalEmailSender;
    const names = maintenanceJobs(db, config, sender).map((job) => job.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("email-outbox");
    expect(names).toContain("push-notifications");
    expect(names).toContain("poison-reaper");
    expect(maintenanceJobs(db, config, null).map((job) => job.name)).not.toContain("email-outbox");
  });
});
