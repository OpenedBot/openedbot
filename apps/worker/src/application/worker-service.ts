import type { SQL } from "bun";
import type { WorkerConfig } from "../config";
import { interruptRequestedRuns } from "@openedbot/execution/application/cancellation-watch";
import { claimRun } from "@openedbot/execution/application/queue";
import { executeRun } from "@openedbot/execution/application/runner";
import { saveRunTimings } from "@openedbot/execution/application/run-timings";
import { createLoopHealth, type LoopHealth } from "../infrastructure/loop-health";
import { createWorkerRegistry, type WorkerRegistry } from "../infrastructure/worker-registry";
import { endRunTrace, RunTrace, runLatencyRecord, startRunTrace } from "@openedbot/platform-observability/run-trace";
import { logEvent } from "@openedbot/platform-observability";
import { runTraceContext, runWithTrace } from "@openedbot/platform-observability/trace-context";
import { createBackgroundJobs, type BackgroundJob } from "./background-jobs";
import { maintenanceJobs } from "./maintenance-jobs";
import { createClaimWakeup, type RunQueueNotifications } from "./claim-wakeup";

const JOB_METRICS_INTERVAL_MS = 15 * 60_000;

export type WorkerService = {
  run(): Promise<void>;
  stop(signal: string): void;
};

/** Seams of the claim loop; production wires the real queue, runner and maintenance. */
export type WorkerServiceDependencies = {
  claimRun: typeof claimRun;
  executeRun: typeof executeRun;
  interruptRequestedRuns: typeof interruptRequestedRuns;
  registry: WorkerRegistry;
  jobs: readonly BackgroundJob[];
  health: LoopHealth;
  runQueueNotifications: RunQueueNotifications;
};

export function createWorkerService(
  db: SQL,
  config: WorkerConfig,
  dependencies: Partial<WorkerServiceDependencies> = {},
): WorkerService {
  const {
    claimRun: claimNextRun = claimRun,
    executeRun: executeClaimedRun = executeRun,
    interruptRequestedRuns: interruptRuns = interruptRequestedRuns,
    registry = createWorkerRegistry(db, config.workerId),
    jobs = maintenanceJobs(db, config),
    health = createLoopHealth(config.healthFile),
    runQueueNotifications,
  } = dependencies;
  const shutdown = new AbortController();
  const wakeup = createClaimWakeup();
  const activeRuns = new Set<string>();
  const runControllers = new Map<string, AbortController>();
  const executions = new Set<Promise<void>>();
  const track = (execution: Promise<void>) => {
    executions.add(execution);
    const settled = () => { executions.delete(execution); };
    void execution.then(settled, settled);
  };
  // La maintenance ne partage plus le tick du claim : chaque job a sa fibre
  // single-flight, et un SMTP ou un provider push lent ne retarde que lui-même.
  const background = createBackgroundJobs(jobs, shutdown.signal, track);
  let cancellationWatch: Promise<void> | null = null;

  function stop(signal: string): void {
    shutdown.abort(signal);
    for (const controller of runControllers.values()) controller.abort(signal);
  }

  async function run(): Promise<void> {
    await registry.recordHeartbeat(activeRuns.size);
    runQueueNotifications?.start(wakeup.notify);
    track(Promise.resolve(health.report()));
    const metricsHeartbeat = setInterval(() => {
      track(Promise.resolve(health.report()));
      track(registry.recordHeartbeat(activeRuns.size).catch((error) => {
        logEvent("worker.metrics_heartbeat_failed", { error: String(error) }, "error");
      }));
    }, 5_000);
    // Passes per job since start: the baseline any change to the background
    // job cadence is measured against.
    const jobMetrics = setInterval(() => {
      logEvent("worker.job_metrics", { jobs: background.stats() });
    }, JOB_METRICS_INTERVAL_MS);

    // Stop is an operator control, not ordinary queue work. Poll only while this
    // process owns runs and cap the latency at 100 ms instead of waiting for the
    // lease heartbeat (10 s with the default 30 s lease).
    const cancellationHeartbeat = setInterval(() => {
      if (runControllers.size === 0 || cancellationWatch) return;
      cancellationWatch = interruptRuns(db, config.workerId, runControllers)
        .then((interrupted) => {
          if (interrupted > 0) {
            logEvent("worker.cancellation_interrupted", { interrupted });
          }
        })
        .catch((error) => {
          logEvent("worker.cancellation_watch_failed", { error: String(error) }, "error");
        })
        .finally(() => {
          cancellationWatch = null;
        });
    }, Math.max(25, Math.min(config.pollMs, 100)));

    background.tick();
    const maintenanceTicker = setInterval(
      () => background.tick(),
      Math.max(25, Math.min(config.pollMs, config.routineTickMs)),
    );

    while (!shutdown.signal.aborted) {
      const beforeClaim = wakeup.generation();
      health.progressed();
      try {
        const claimStartedAt = performance.now();
        const run = activeRuns.size < config.maxActiveRuns ? await claimNextRun(db, config) : null;
        if (run) {
          const trace = startRunTrace(run.id, new RunTrace(undefined, claimStartedAt));
          trace.mark("worker.claimed");
          trace.set("lease_generation", run.leaseGeneration);
          activeRuns.add(run.id);
          const controller = new AbortController();
          runControllers.set(run.id, controller);
          // The run's trace context (trace id = run id, one span per claim)
          // covers the whole execution, its relay requests and its last lines:
          // every one of them carries traceId/spanId.
          const execution = runWithTrace(runTraceContext(run.id), () => {
            logEvent("worker.run_claimed", {
              runId: run.id,
              organizationId: run.organizationId,
              leaseGeneration: run.leaseGeneration,
              workerId: config.workerId,
            });
            return executeClaimedRun(db, config, run, controller.signal)
              .catch((error) => {
                logEvent("worker.execute_unhandled", { runId: run.id, error: String(error) }, "error");
              })
              .finally(() => {
                activeRuns.delete(run.id);
                runControllers.delete(run.id);
                wakeup.notify();
                const finished = endRunTrace(run.id);
                if (finished) {
                  const latency = runLatencyRecord({
                    runId: run.id,
                    organizationId: run.organizationId,
                    queuedMs: run.queuedMs ?? null,
                    trace: finished,
                  });
                  logEvent("run.latency", latency);
                  // Sans attendre : la boucle de réclamation ne ralentit pas pour une mesure.
                  track(saveRunTimings(db, run, latency));
                }
              });
          });
          track(execution);
          continue;
        }
      } catch (error) {
        logEvent("worker.loop_failed", { error: String(error) }, "error");
        await wait(1_000, shutdown.signal);
      }
      await wakeup.wait(beforeClaim, config.pollMs, shutdown.signal);
    }

    clearInterval(maintenanceTicker);
    clearInterval(cancellationHeartbeat);
    await cancellationWatch;
    clearInterval(metricsHeartbeat);
    clearInterval(jobMetrics);
    await runQueueNotifications?.stop().catch(() => {
      logEvent("worker.queue_listener_close_failed", {}, "error");
    });
    for (const controller of runControllers.values()) controller.abort("worker_shutdown");
    // A pass still in flight may track more work (a review it just started):
    // drain until nothing is left, never on a snapshot.
    while (executions.size > 0) await Promise.allSettled([...executions]);
    await registry.releaseLeasesAndClose();
  }

  return { run, stop };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { signal.removeEventListener("abort", onAbort); resolve(); };
    const timeout = setTimeout(finish, ms);
    const onAbort = () => { clearTimeout(timeout); finish(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
