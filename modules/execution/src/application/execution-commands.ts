import type { SQL } from "bun";
import type { HermesClient } from "@openedbot/hermes";
import type { Db } from "@openedbot/platform-db";
import { isUniqueViolation, withTenant } from "@openedbot/platform-db";
import {
  compactThreadNow,
  persistThreadCompactionTx,
  type CompactHermes,
  type PersistCompaction,
} from "@openedbot/conversation/application/compact-thread";
import { readRoomCompactionTarget, type RoomCompactionTarget } from "@openedbot/conversation/application/compact-room-request";
import { readRuntimeRowById, type RuntimeRow } from "@openedbot/runtimes/sql/runtime-rows";
import {
  claimExecutionCommand,
  finishExecutionCommand,
  insertExecutionCommandTx,
  readActiveCommandTx,
  readCommandByKeyTx,
  readExecutionCommandTx,
  recordCommandHermesRun,
  recordCommandProgressTx,
  releaseExecutionCommand,
  renewCommandLease,
  requestCommandCancelTx,
  withdrawQueuedCommandTx,
  type CommandOutcome,
  type ExecutionCommandRow,
} from "../sql/execution-commands";
import { applyRuntimeModelSelection } from "./runner/provider-recovery";
import { log } from "./runner/util";

/**
 * Durable execution commands (ADR 0001 S3, section 4.6). The API records a
 * mutation of execution and the worker executes it under a fenced lease: the
 * API process never opens a session or a run on Hermes. First kind: the
 * on-demand room compaction (DEV-332).
 *
 * Lifecycle: `queued` (recorded by the API) → `running` (claimed, one attempt
 * counted) → `succeeded` | `failed` | `cancelled`. A worker that dies leaves an
 * expired lease, claimed again until `COMMAND_MAX_ATTEMPTS`; a stopping worker
 * hands the command back; a cancellation reaches a running command through
 * its heartbeat. Errors are stable codes (`ExecutionCommandError`, the
 * command's `errorCode`); `apps/api` maps them to HTTP.
 */

export const THREAD_COMPACT = "thread.compact" as const;
export const COMMAND_LEASE_SECONDS = 60;
export const COMMAND_HEARTBEAT_MS = 15_000;
export const COMMAND_MAX_ATTEMPTS = 3;
/** A command never started and still queued after this was asked by nobody still waiting: it is failed, not run. */
export const COMMAND_STALE_SECONDS = 300;
/** Retention of settled commands. */
export const COMMAND_RETENTION_DAYS = 7;
/**
 * Up to four one-minute summary passes (`compactThreadNow`), as the request
 * allowed before S3; past it the attempt stops and the command fails.
 */
export const COMPACTION_DEADLINE_MS = 250_000;

export type ExecutionCommandErrorCode = "COMMAND_IN_PROGRESS" | "IDEMPOTENCY_KEY_REUSED";

export class ExecutionCommandError extends Error {
  constructor(readonly code: ExecutionCommandErrorCode, readonly command: ExecutionCommandRow | null = null) {
    super(code);
    this.name = "ExecutionCommandError";
  }
}

export type { ExecutionCommandRow };

/** What a compaction command stores once it succeeded (`ThreadCompactResult` without `compacted`). */
export type ThreadCompactionCommandResult = {
  summarizedCount: number;
  compactedThroughSequence: number;
  compactedAt: string;
};

/**
 * Records a compaction of the thread. With an idempotency key already used by
 * this user, the command it recorded is returned (`replayed`), whatever its
 * state; another thread under the same key is refused. Without a key, or with
 * a new one, an active compaction of the thread refuses the request
 * (`COMMAND_IN_PROGRESS`): one summary at a time per thread, across replicas.
 */
export async function submitThreadCompaction(
  db: Db,
  input: { organizationId: string; threadId: string; runtimeId: string; userId: string; idempotencyKey: string | null },
): Promise<{ command: ExecutionCommandRow; replayed: boolean }> {
  const attempt = () => withTenant(db, input.organizationId, async (tx) => {
    if (input.idempotencyKey) {
      const existing = await readCommandByKeyTx(tx, input.organizationId, input.userId, THREAD_COMPACT, input.idempotencyKey);
      if (existing) {
        if (existing.threadId !== input.threadId) throw new ExecutionCommandError("IDEMPOTENCY_KEY_REUSED", existing);
        return { command: existing, replayed: true };
      }
    }
    const inserted = await insertExecutionCommandTx(tx, {
      organizationId: input.organizationId,
      kind: THREAD_COMPACT,
      threadId: input.threadId,
      runtimeId: input.runtimeId,
      requestedByUserId: input.userId,
      idempotencyKey: input.idempotencyKey,
    });
    if (inserted) return { command: inserted, replayed: false };
    if (input.idempotencyKey) {
      // The same key raced us and won: its command now holds the thread.
      const winner = await readCommandByKeyTx(tx, input.organizationId, input.userId, THREAD_COMPACT, input.idempotencyKey);
      if (winner) {
        if (winner.threadId !== input.threadId) throw new ExecutionCommandError("IDEMPOTENCY_KEY_REUSED", winner);
        return { command: winner, replayed: true };
      }
    }
    const active = await readActiveCommandTx(tx, input.organizationId, THREAD_COMPACT, input.threadId);
    throw new ExecutionCommandError("COMMAND_IN_PROGRESS", active);
  });
  try {
    return await attempt();
  } catch (error) {
    // Two requests under the same key raced: the loser reads the winner's command.
    if (input.idempotencyKey && isUniqueViolation(error)) return attempt();
    throw error;
  }
}

/**
 * The compaction this user already recorded under `key`, read before any
 * guard: once its summary is written the thread is below the threshold, and
 * only the recorded command still answers a replayed request.
 */
export async function readThreadCompactionReplay(
  db: Db,
  input: { organizationId: string; threadId: string; userId: string; idempotencyKey: string },
): Promise<ExecutionCommandRow | null> {
  const existing = await withTenant(db, input.organizationId, (tx) =>
    readCommandByKeyTx(tx, input.organizationId, input.userId, THREAD_COMPACT, input.idempotencyKey));
  if (existing && existing.threadId !== input.threadId) throw new ExecutionCommandError("IDEMPOTENCY_KEY_REUSED", existing);
  return existing;
}

const SETTLED: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

export function commandSettled(command: Pick<ExecutionCommandRow, "status">): boolean {
  return SETTLED.has(command.status);
}

/**
 * Waits for the command to settle by re-reading its row. Returns the last row
 * read: settled, or still active when `deadlineMs` passed or `signal` aborted
 * (the caller went away; the command goes on). Null when the row is gone (its
 * thread was deleted). A command still `queued` at the deadline and never
 * started was claimed by no worker: it is withdrawn (`COMMAND_NOT_STARTED`),
 * so that a worker coming back later does not run a summary nobody waits for.
 */
export async function awaitExecutionCommand(
  db: Db,
  organizationId: string,
  commandId: string,
  options: { deadlineMs: number; signal?: AbortSignal; pollMs?: number },
): Promise<ExecutionCommandRow | null> {
  const deadline = Date.now() + options.deadlineMs;
  let pollMs = Math.min(options.pollMs ?? 250, 1_000);
  for (;;) {
    const command = await withTenant(db, organizationId, (tx) => readExecutionCommandTx(tx, organizationId, commandId));
    if (!command || commandSettled(command) || options.signal?.aborted) return command;
    if (Date.now() >= deadline) {
      if (command.status !== "queued") return command;
      // Only a command no worker ever started is withdrawn; one handed back
      // by a stopping worker stays queued for the next one.
      await withTenant(db, organizationId, (tx) => withdrawQueuedCommandTx(tx, organizationId, commandId));
      return withTenant(db, organizationId, (tx) => readExecutionCommandTx(tx, organizationId, commandId));
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), options.signal);
    pollMs = Math.min(pollMs * 2, 1_000);
  }
}

/** Cancels the thread's active compaction; null when there is none. */
export async function cancelThreadCompaction(db: Db, organizationId: string, threadId: string): Promise<ExecutionCommandRow | null> {
  return withTenant(db, organizationId, (tx) => requestCommandCancelTx(tx, organizationId, THREAD_COMPACT, threadId));
}

// ── Worker ───────────────────────────────────────────────────────────────────

export function claimNextExecutionCommand(db: SQL, workerId: string): Promise<ExecutionCommandRow | null> {
  return claimExecutionCommand(db, {
    workerId,
    leaseSeconds: COMMAND_LEASE_SECONDS,
    maxAttempts: COMMAND_MAX_ATTEMPTS,
    staleSeconds: COMMAND_STALE_SECONDS,
  });
}

/** The summary's verbs, plus `stopRun` for a cancellation. */
export type CommandHermes = CompactHermes & Pick<HermesClient, "stopRun">;

/** Bounds the stop of a cancelled summary: the command settles even if the host does not answer. */
const STOP_TIMEOUT_MS = 10_000;

export type ExecutionCommandDeps = {
  /** The client of the command's runtime, on `profile` for a connector link. */
  client(runtime: RuntimeRow, profile: string | null): CommandHermes;
  /** The worker's shutdown: the command is handed back, not failed. */
  signal: AbortSignal;
  heartbeatMs?: number;
  leaseSeconds?: number;
  deadlineMs?: number;
  compact?: typeof compactThreadNow;
};

const TARGET_REFUSALS: Record<Exclude<RoomCompactionTarget["kind"], "ready">, string> = {
  not_found: "THREAD_NOT_FOUND",
  not_room: "THREAD_NOT_ROOM",
  run_active: "RUN_IN_PROGRESS",
  below_threshold: "COMPACTION_BELOW_THRESHOLD",
};

/**
 * Executes a claimed command. The thread is read again: what the API checked
 * may have changed while the command waited (a run started, the room was
 * compacted by its own turn). Every write is fenced by the lease; once the
 * lease is lost the attempt stops writing and the next holder decides.
 */
export async function executeExecutionCommand(db: SQL, command: ExecutionCommandRow, deps: ExecutionCommandDeps): Promise<void> {
  const leaseSeconds = deps.leaseSeconds ?? COMMAND_LEASE_SECONDS;
  const stop = new AbortController();
  // Written by the heartbeat while the summary runs: read through the object.
  const state: { stop: "cancelled" | "lease_lost" | null } = { stop: command.cancelRequestedAt ? "cancelled" : null };
  if (state.stop) stop.abort(state.stop);
  const halt = (reason: "cancelled" | "lease_lost") => {
    state.stop ??= reason;
    if (!stop.signal.aborted) stop.abort(state.stop);
  };
  /** Why a fenced write was refused: the lease is gone, or a cancellation was asked. */
  const refused = async () => {
    const renewed = await renewCommandLease(db, command, leaseSeconds);
    halt(renewed?.cancelRequested ? "cancelled" : "lease_lost");
  };
  let renewing: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (renewing || stop.signal.aborted) return;
    renewing = renewCommandLease(db, command, leaseSeconds)
      .then((renewed) => {
        if (!renewed) halt("lease_lost");
        else if (renewed.cancelRequested) halt("cancelled");
      })
      .catch(() => log("execution_command.heartbeat_failed", { commandId: command.id }))
      .finally(() => { renewing = null; });
  }, deps.heartbeatMs ?? COMMAND_HEARTBEAT_MS);
  const fields = { commandId: command.id, organizationId: command.organizationId, kind: command.kind, attempt: command.attempts, generation: command.leaseGeneration };
  /**
   * Settles the command. Refused once a cancellation was asked (only
   * `cancelled` settles it then, after stopping the host run) or once the
   * lease is lost (the next holder decides).
   */
  const settle = async (outcome: CommandOutcome): Promise<void> => {
    if (await finishExecutionCommand(db, command, outcome)) {
      log(`execution_command.${outcome.status}`, { ...fields, ...(outcome.status === "succeeded" ? {} : { code: outcome.errorCode }) });
      return;
    }
    if (outcome.status !== "cancelled") {
      await refused();
      if (state.stop === "cancelled") return cancel();
    }
    log("execution_command.lease_lost", fields);
  };
  // What this command has written so far, earlier attempts included.
  const written: { current: ThreadCompactionCommandResult | null } = { current: commandProgress(command.progress) };
  // The summary run on the host, this attempt's or the one an earlier attempt recorded.
  const hermesRun: { current: { id: string; profile: string | null } | null } = { current: command.hermesRun };
  const runtimeRow = async () => (await withTenant(db, command.organizationId, (tx) =>
    readRuntimeRowById(tx, command.organizationId, command.runtimeId)))[0] ?? null;
  // A connector link serves the member's profile (`/p/<slug>`), as its run
  // does; a direct runtime has none.
  const clientFor = (runtime: RuntimeRow, profile: string | null) =>
    deps.client(runtime, runtime.reachability === "connector" ? profile : null);
  /**
   * Asked to stop: the summary run on the host stops too, before the thread
   * is free for another one. A lost lease or a worker shutdown leaves it
   * running, for the next attempt reuses it by its key.
   */
  const stopRun = async (run: { id: string; profile: string | null }) => {
    try {
      const runtime = await runtimeRow();
      if (runtime) await clientFor(runtime, run.profile).stopRun(run.id, AbortSignal.timeout(STOP_TIMEOUT_MS));
    } catch (error) {
      log("execution_command.stop_failed", { ...fields, error: error instanceof Error ? error.name : "unknown" });
    }
  };
  const cancel = async () => {
    if (hermesRun.current) await stopRun(hermesRun.current);
    await settle({ status: "cancelled", errorCode: "COMMAND_CANCELLED" });
  };
  /**
   * Settles before running anything: a summary run an earlier attempt left on
   * the host (handed back on shutdown, or its worker died) is stopped first,
   * since no later attempt will hold its handle once the command is terminal.
   */
  const settleBeforeRun = async (outcome: CommandOutcome) => {
    if (hermesRun.current) await stopRun(hermesRun.current);
    await settle(outcome);
  };
  // Each pass's summary is written in one transaction with the command's
  // progress, under the lease and unless a cancellation was asked: a worker
  // whose lease lapsed, or a cancelled command, writes nothing.
  const persist: PersistCompaction = async (compaction) => {
    const next: ThreadCompactionCommandResult = {
      summarizedCount: (written.current?.summarizedCount ?? 0) + compaction.sourceMessageCount,
      compactedThroughSequence: compaction.compactedThroughSequence,
      compactedAt: new Date().toISOString(),
    };
    const recorded = await withTenant(db, command.organizationId, async (tx) => {
      if (!(await recordCommandProgressTx(tx, command, next))) return false;
      await persistThreadCompactionTx(tx, command.organizationId, command.threadId, compaction);
      return true;
    });
    if (recorded) written.current = next;
    else await refused();
    return recorded;
  };
  log("execution_command.started", fields);
  try {
    if (state.stop === "cancelled") return await cancel();
    // Claimed past its attempts only to stop the run an earlier one left on the host.
    if (command.attempts > COMMAND_MAX_ATTEMPTS) {
      return await settleBeforeRun(written.current
        ? { status: "succeeded", result: written.current }
        : { status: "failed", errorCode: "COMMAND_ATTEMPTS_EXHAUSTED" });
    }
    const target = await readRoomCompactionTarget(db, command.organizationId, command.threadId);
    if (target.kind !== "ready") {
      // An earlier attempt wrote its summary and died before settling: the
      // thread is now below the threshold because of that very work.
      if (written.current) return await settleBeforeRun({ status: "succeeded", result: written.current });
      return await settleBeforeRun({ status: "failed", errorCode: TARGET_REFUSALS[target.kind] });
    }
    const runtime = await runtimeRow();
    if (!runtime?.isActive) return await settleBeforeRun({ status: "failed", errorCode: "RUNTIME_REQUIRED" });
    let client: CommandHermes;
    try {
      client = clientFor(runtime, target.speaker.profile);
    } catch {
      return await settleBeforeRun({ status: "failed", errorCode: "RUNTIME_CREDENTIALS_MISSING" });
    }
    const selection = applyRuntimeModelSelection(
      { model: target.speaker.model, reasoningEffort: target.speaker.reasoningEffort },
      { provider: runtime.selectedProvider, model: runtime.selectedModel, reasoningEffort: runtime.reasoningEffort },
      target.assignmentMode,
    );
    await (deps.compact ?? compactThreadNow)(
      db,
      client,
      {
        organizationId: command.organizationId,
        threadId: command.threadId,
        model: selection.model,
        provider: selection.provider,
        reasoningEffort: selection.reasoningEffort,
        operatorName: target.operatorName,
        idempotencyId: command.id,
        persist,
        onRun: async (id) => {
          // A retry that could not reuse the earlier attempt's run (new
          // messages moved its key, another speaker): that run is stopped
          // before its handle is replaced, so a worker dying in between
          // still leaves it to the next attempt. The new run needs no such
          // care: its key is derived from the command, a next attempt finds it.
          const previous = hermesRun.current;
          if (previous && previous.id !== id) await stopRun(previous);
          hermesRun.current = { id, profile: target.speaker.profile };
          if (!(await recordCommandHermesRun(db, command, hermesRun.current))) return refused();
        },
      },
      AbortSignal.any([deps.signal, stop.signal, AbortSignal.timeout(deps.deadlineMs ?? COMPACTION_DEADLINE_MS)]),
    );
    if (state.stop === "lease_lost") return log("execution_command.lease_lost", fields);
    if (state.stop === "cancelled") return await cancel();
    if (deps.signal.aborted) return await handBack();
    if (!written.current) return await settle({ status: "failed", errorCode: "COMPACTION_FAILED" });
    await settle({ status: "succeeded", result: written.current });
  } catch (error) {
    if (deps.signal.aborted) return await handBack();
    log("execution_command.unexpected", { ...fields, error: error instanceof Error ? error.name : "unknown" });
    await settle({ status: "failed", errorCode: "COMMAND_FAILED" }).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
    await renewing;
  }

  async function handBack(): Promise<void> {
    const released = await releaseExecutionCommand(db, command);
    log(released ? "execution_command.released" : "execution_command.lease_lost", fields);
  }
}

function commandProgress(value: Record<string, unknown> | null): ThreadCompactionCommandResult | null {
  if (!value || typeof value.compactedThroughSequence !== "number") return null;
  return {
    summarizedCount: Number(value.summarizedCount ?? 0),
    compactedThroughSequence: value.compactedThroughSequence,
    compactedAt: String(value.compactedAt ?? new Date().toISOString()),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
