import { createHash, randomUUID } from "node:crypto";
import type { SQL } from "bun";
import type { HermesClient } from "@openedbot/hermes";
import { logger } from "../../platform/observability/src/logger";
import { claimRun } from "../../modules/execution/src/application/queue";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import { forwardNextRunSteer } from "../../modules/execution/src/application/run-steering";
import { withDisposablePostgres } from "./disposable-postgres";

type Report = {
  pass: boolean;
  stage: number;
  waitLockObserved: boolean;
  targetLockableWhileWaiting: boolean;
  targetClaimed: boolean;
  forwardSettled: boolean;
  queueSettled: boolean;
  cleanupSettled: boolean;
  activityPolls: number;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, resolve: release };
}

function within<T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bounded wait expired")), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); reject(new Error("bounded operation failed")); },
    );
  });
}

async function waitForLock(owner: SQL, pid: number): Promise<{ observed: boolean; polls: number }> {
  const deadline = performance.now() + 5_000;
  let polls = 0;
  while (polls < 100 && performance.now() < deadline) {
    const rows = await owner<Array<{ waitEventType: string | null }>>`
      select wait_event_type as "waitEventType" from pg_stat_activity where pid = ${pid}
    `;
    polls += 1;
    if (rows[0]?.waitEventType === "Lock") return { observed: true, polls };
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
  return { observed: false, polls };
}

async function main(): Promise<Report> {
  logger.level = "silent";
  const report: Report = {
    pass: false,
    stage: 0,
    waitLockObserved: false,
    targetLockableWhileWaiting: false,
    targetClaimed: false,
    forwardSettled: false,
    queueSettled: false,
    cleanupSettled: false,
    activityPolls: 0,
  };

  try {
    await withDisposablePostgres("ohb117_steer_lock_order", async ({ owner, connect }) => {
      report.stage = 1;
      const organizationId = randomUUID();
      const sectionId = randomUUID();
      const botId = randomUUID();
      const threadId = randomUUID();
      const runtimeId = randomUUID();
      const sourceRunId = "00000000-0000-4000-8000-000000000001";
      const targetRunId = "00000000-0000-4000-8000-000000000002";
      const attemptId = randomUUID();
      const steerWorkerId = `ohb117-steer-${randomUUID()}`;
      const claimWorkerId = `ohb117-claim-${randomUUID()}`;
      const hermesSessionId = `ohb117-${randomUUID()}`;
      const leaseGeneration = 7;
      const postEntered = deferred();
      const releasePost = deferred();
      const sourceLocked = deferred();
      const releaseSource = deferred();
      let forwardSettled: Promise<void> | null = null;
      let queueSettled: Promise<void> | null = null;

      try {
        await owner`set statement_timeout = '500ms'`;
        report.stage = 10;
        await owner`insert into organizations (id, slug, name)
          values (${organizationId}, ${`steer-lock-${organizationId.slice(0, 8)}`}, 'Steer lock order')`;
        report.stage = 11;
        await owner`insert into sections (id, organization_id, name, position)
          values (${sectionId}, ${organizationId}, 'Integration', 0)`;
        report.stage = 12;
        await owner`insert into bots (id, organization_id, section_id, name, slug, position)
          values (${botId}, ${organizationId}, ${sectionId}, 'Steer lock order', ${`steer-lock-${botId.slice(0, 8)}`}, 0)`;
        report.stage = 13;
        await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
          values (${threadId}, ${organizationId}, ${botId}, 'Steer lock order', ${hermesSessionId}, true)`;
        report.stage = 14;
        const linkHash = createHash("sha256").update(randomUUID()).digest("hex");
        await owner`insert into runtimes (
          id, organization_id, name, reachability, endpoint, token_ciphertext, token_nonce, token_tag,
          link_token_hash, is_active, capacity, link_last_seen_at
        ) values (
          ${runtimeId}, ${organizationId}, 'Steer lock fixture', 'connector', null, null, null, null,
          ${linkHash}, true, 1, now()
        )`;
        report.stage = 15;
        await owner`insert into runs (
          id, organization_id, thread_id, bot_id, input, status, hermes_run_id, created_at,
          started_at, heartbeat_at, lease_owner, lease_expires_at, lease_generation,
          external_state, step_index, step_kind, execution_session_key
        ) values (
          ${targetRunId}, ${organizationId}, ${threadId}, ${botId}, 'active turn', 'running',
          'hermes-lock-target', now() - interval '10 minutes', now(), now(), ${steerWorkerId},
          now() + interval '1 minute', ${leaseGeneration}, 'streaming', 0, 'root', ${hermesSessionId}
        )`;
        report.stage = 16;
        await owner`insert into runs (
          id, organization_id, thread_id, bot_id, input, status, created_at, external_state, step_index, step_kind
        ) values (
          ${sourceRunId}, ${organizationId}, ${threadId}, ${botId}, 'queued follow-up', 'queued',
          now() - interval '5 minutes', 'not_started', 0, 'root'
        )`;
        report.stage = 17;
        await owner`insert into run_steering_attempts (
          id, organization_id, thread_id, target_run_id, source_run_id, text, status
        ) values (
          ${attemptId}, ${organizationId}, ${threadId}, ${targetRunId}, ${sourceRunId}, 'follow-up', 'pending'
        )`;
        report.stage = 2;

        const steerDb = await connect("ohb_worker");
        const queueDb = await connect("ohb_worker");
        await steerDb`select set_config('app.organization_id', ${organizationId}, false)`;
        await queueDb`select set_config('app.organization_id', ${organizationId}, false)`;
        await steerDb`set statement_timeout = '5s'`;
        await queueDb`set statement_timeout = '5s'`;
        const backendRows = await queueDb<Array<{ pid: number }>>`select pg_backend_pid() as pid`;
        const queuePid = Number(backendRows[0]?.pid);
        if (!Number.isInteger(queuePid) || queuePid <= 0) throw new Error("worker backend unavailable");
        report.stage = 3;

        const originalBegin = steerDb.begin.bind(steerDb) as (work: (tx: SQL) => Promise<unknown>) => Promise<unknown>;
        let beginCalls = 0;
        const steerConnection = steerDb as unknown as {
          begin: (work: (tx: SQL) => Promise<unknown>) => Promise<unknown>;
        };
        steerConnection.begin = (work) => {
          beginCalls += 1;
          if (beginCalls !== 2) return originalBegin(work);
          return originalBegin(async (tx) => {
            await tx`select id from runs
              where organization_id = ${organizationId} and id = ${sourceRunId} for update`;
            sourceLocked.resolve();
            await releaseSource.promise;
            return work(tx);
          });
        };

        const fakeClient = {
          steerRun: async () => {
            postEntered.resolve();
            await releasePost.promise;
            return 202;
          },
        } as unknown as HermesClient;
        const forwardPromise = forwardNextRunSteer(
          steerDb,
          fakeClient,
          { workerId: steerWorkerId, leaseSeconds: 30 },
          { id: targetRunId, organizationId, threadId, leaseGeneration },
          "hermes-lock-target",
          new AbortController().signal,
        );
        forwardSettled = forwardPromise.then(() => { report.forwardSettled = true; }, () => { report.forwardSettled = true; });
        await within(postEntered.promise);
        report.stage = 4;

        await owner`update runs set lease_expires_at = now() - interval '1 second'
          where organization_id = ${organizationId} and id = ${targetRunId}`;
        await owner`update run_steering_attempts set forwarding_lease_expires_at = now() - interval '1 second'
          where organization_id = ${organizationId} and id = ${attemptId} and status = 'sending'`;
        releasePost.resolve();
        await within(sourceLocked.promise);
        report.stage = 5;

        const queueConfig = {
          workerId: claimWorkerId,
          leaseSeconds: 30,
          billingEnforced: false,
        } as WorkerConfig;
        const claimPromise = claimRun(queueDb, queueConfig);
        queueSettled = claimPromise.then((claimed) => {
          report.targetClaimed = claimed?.id === targetRunId;
          report.queueSettled = true;
        }, () => { report.queueSettled = true; });
        report.stage = 6;

        const lockWait = await waitForLock(owner, queuePid);
        report.waitLockObserved = lockWait.observed;
        report.activityPolls = lockWait.polls;
        try {
          await owner.begin(async (tx) => {
            await tx`select id from runs
              where organization_id = ${organizationId} and id = ${targetRunId} for update nowait`;
          });
          report.targetLockableWhileWaiting = true;
        } catch {
          report.targetLockableWhileWaiting = false;
        }
        report.stage = 7;
      } finally {
        releasePost.resolve();
        releaseSource.resolve();
        const pending = [forwardSettled, queueSettled].filter((promise): promise is Promise<void> => promise !== null);
        try {
          await within(Promise.all(pending).then(() => undefined));
          report.cleanupSettled = true;
        } catch {
          report.cleanupSettled = false;
        }
      }

      report.pass = report.waitLockObserved && report.targetLockableWhileWaiting &&
        report.targetClaimed && report.forwardSettled && report.queueSettled && report.cleanupSettled;
    });
  } catch {
    report.pass = false;
  }
  return report;
}

const report = await main();
console.log(JSON.stringify(report));
if (!report.pass) process.exitCode = 1;
