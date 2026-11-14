import type { SQL } from "bun";
import { type HermesClient, HermesClientError, type HermesRunDetails } from "@openedbot/hermes";
import { HERMES_RUN_INTERRUPTED_CODE } from "@openedbot/contracts-errors";
import type { RunTrace } from "@openedbot/platform-observability/run-trace";
import type { WorkerConfig } from "../worker-config";
import { reconciledFailureMessage } from "../provider-fallback";
import { replayUndeliveredRunSteers } from "../run-steering";
import { markRunUnknown } from "./failure";
import type { RunEvent } from "../../domain/hermes-events";
import { readNextRunEventSequence } from "../../sql/run-events";
import { persistEvents, persistUnnumberedEvents } from "./persist";
import type { EventContext, RunContext } from "./types";
import { describe, log, pollWait } from "./util";

async function readReconciliationJournal(
  db: SQL,
  config: Pick<WorkerConfig, "workerId">,
  context: Pick<RunContext, "id" | "organizationId" | "leaseGeneration">,
  hermesRunId: string,
): Promise<{ hasText: boolean; watermark: number } | null> {
  const rows = await db<Array<{ hasText: boolean; watermark: number }>>`
    select coalesce(bool_or(event.type = 'agent.message'), false) as "hasText",
           run.last_hermes_sequence as watermark
      from runs run left join run_events event
        on event.organization_id = run.organization_id and event.run_id = run.id
     where run.organization_id = ${context.organizationId} and run.id = ${context.id}
       and run.hermes_run_id = ${hermesRunId}
       and run.lease_owner = ${config.workerId} and run.lease_generation = ${context.leaseGeneration}
     group by run.id
  `;
  return rows[0] ?? null;
}

/**
 * Why openedbot stopped the run, when it did: a Hermes `cancelled` that answers
 * that stop is named after its cause instead of the generic
 * `HERMES_RUN_CANCELLED` (PERM2-9: an expired gate says so on the run).
 */
export type ReconcileStopCause = { errorCode: string; message: string };

/**
 * Polls a known Hermes id after an SSE gap. GET is safe to repeat; POST create
 * never is. A terminal state is converted to the same durable events as SSE.
 */
export async function reconcileHermesRun(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  hermesRunId: string,
  signal: AbortSignal,
  trace?: RunTrace,
  stopCause?: ReconcileStopCause,
): Promise<void> {
  trace?.set("resume_mode", "status_polling");
  // A confirmed stop starts a bounded read-only cleanup phase. Reusing an
  // exhausted work deadline here would skip every poll and invent ambiguity.
  const confirmingStop = Boolean(stopCause) && context.remoteStopState === "confirmed";
  const workflowDeadline = context.workflowId && context.workflowStatus !== "reconciling" && !confirmingStop
    ? (await db<Array<{ deadlineAt: Date | string }>>`
        select deadline_at as "deadlineAt" from workflows
         where organization_id = ${context.organizationId} and id = ${context.workflowId}
      `)[0]?.deadlineAt
    : null;
  const workflowDeadlineMs = workflowDeadline ? new Date(workflowDeadline).getTime() : Number.POSITIVE_INFINITY;
  let deadline = Math.min(Date.now() + config.reconciliationTimeoutMs, workflowDeadlineMs);
  let delayMs = 1_000;
  while (!signal.aborted && Date.now() < deadline) {
    let details: HermesRunDetails;
    try {
      details = await client.getRunStatus(hermesRunId, signal);
    } catch (error) {
      if (error instanceof HermesClientError && error.code === "HERMES_RUN_MISSING") {
        await markRunUnknown(db, config, context, error.code, error.message);
        return;
      }
      if (!(error instanceof HermesClientError) || error.code !== "HERMES_UNREACHABLE") {
        await markRunUnknown(
          db,
          config,
          context,
          error instanceof HermesClientError ? error.code : "HERMES_RECONCILIATION_FAILED",
          error instanceof Error ? error.message : "L’état Hermes est illisible.",
        );
        return;
      }
      if (signal.aborted) break;
      await pollWait(delayMs, signal);
      delayMs = Math.min(5_000, delayMs * 2);
      continue;
    }

    if (details.status === "completed") {
      trace?.mark("hermes.status_terminal");
      if (details.output === null) {
        await markRunUnknown(db, config, context, "HERMES_TERMINAL_OUTPUT_MISSING",
          "Hermes annonce le run terminé mais ne fournit pas sa sortie.");
        return;
      }
      const journal = await readReconciliationJournal(db, config, context, hermesRunId);
      if (!journal) return;
      // Numbered like the stream, from a proposal checked again under the
      // run's locks: the recovered text leaves before the commit, as a delta does.
      const sequence = await readNextRunEventSequence(db, context.organizationId, context.id);
      const events: RunEvent[] = [];
      const occurredAt = new Date();
      // Status recovery has an authoritative answer even when no delta survived.
      // Publish that real text under the normal run identity before its terminal.
      // An existing delta already marks first text; do not append the full answer twice.
      if (!journal.hasText && details.output.trim().length > 0) events.push({
        sequence,
        type: "agent.message",
        occurredAt,
        payload: { text: details.output, reconciled: true },
      });
      events.push({
        sequence: sequence + events.length,
        type: "run.completed",
        occurredAt,
        payload: { output: details.output, usage: details.usage, reconciled: true },
      });
      await persistEvents(db, config, context, Number(journal.watermark), events, client, trace);
      await replayUndeliveredRunSteersSafely(db, context, details.pendingSteer);
      return;
    }
    if (details.status === "unknown") {
      // Hermes 0.23: the turn died with its process. Resolve it first, or the
      // session's next turns wait behind it; then count it as interrupted.
      await resolveUnknownTurn(client, hermesRunId, details, signal, (code) =>
        log("run.unknown_resolve_failed", { runId: context.id, code }));
    }
    if (details.status === "failed" || details.status === "interrupted" || details.status === "cancelled" || details.status === "unknown") {
      trace?.mark("hermes.status_terminal");
      const journal = await readReconciliationJournal(db, config, context, hermesRunId);
      if (!journal) return;
      // Un échec après repli dit pourquoi le premier fournisseur a été quitté.
      const [fallback] = details.status === "failed"
        ? await db<Array<{ payload: Record<string, unknown> }>>`
            select payload from run_events
             where organization_id = ${context.organizationId} and run_id = ${context.id}
               and type = 'run.provider_fallback'
             order by sequence desc limit 1
          `
        : [];
      await persistUnnumberedEvents(db, config, context, Number(journal.watermark), [{
        type: "run.error",
        occurredAt: new Date(),
        payload: {
          message: details.status === "cancelled"
            ? stopCause?.message ?? "Run Hermes annulé."
            : details.status === "interrupted" || details.status === "unknown"
              ? "Le gateway Hermes a interrompu le run, probablement lors d’un redémarrage."
              : reconciledFailureMessage(fallback?.payload),
          errorCode: details.status === "cancelled"
            ? stopCause?.errorCode ?? "HERMES_RUN_CANCELLED"
            : details.status === "interrupted" || details.status === "unknown" ? HERMES_RUN_INTERRUPTED_CODE : "HERMES_RUN_FAILED",
          reconciled: true,
        },
      }], undefined, trace);
      return;
    }
    // Hermes attend l'opérateur : l'horloge de réconciliation ne court pas tant
    // que la gate est ouverte. Son expiration (heartbeat) et le délai du workflow
    // restent les bornes.
    const openGate = await db<Array<{ id: string }>>`
      select gate.id from approval_requests gate
        join runs run on run.organization_id = gate.organization_id and run.id = gate.run_id
       where gate.organization_id = ${context.organizationId} and gate.run_id = ${context.id}
         and run.status = 'awaiting_approval'
         and gate.forward_state in ('pending','ready','sending')
       limit 1
    `;
    if (openGate[0]) {
      deadline = Math.max(deadline, Math.min(Date.now() + config.reconciliationTimeoutMs, workflowDeadlineMs));
    }
    await pollWait(delayMs, signal);
    delayMs = Math.min(5_000, delayMs * 2);
  }
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(typeof signal.reason === "string" ? signal.reason : "reconciliation_aborted");
  }
  await markRunUnknown(db, config, context, "HERMES_RECONCILIATION_TIMEOUT",
    "L’état terminal Hermes n’a pas pu être confirmé avant la limite de réconciliation.");
}

/** Le champ brut du SSE : absent, nul ou vide, rien à rejouer. */
export function pendingSteerOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

/**
 * Le run est déjà réglé quand on arrive ici : un rejeu qui échoue ne doit pas
 * le faire passer pour raté, mais il se lit dans le journal, avec le nombre de
 * caractères non lus, pour qu'on sache qu'un message d'opérateur attend.
 */
export async function replayUndeliveredRunSteersSafely(
  db: SQL,
  context: Pick<EventContext, "id" | "organizationId">,
  pendingSteer: string | null,
): Promise<void> {
  if (!pendingSteer) return;
  try {
    const replayed = await replayUndeliveredRunSteers(db, context, pendingSteer);
    log("worker.run_steer_replayed", {
      runId: context.id,
      organizationId: context.organizationId,
      replayed,
      pendingChars: pendingSteer.length,
    });
  } catch (error) {
    log("worker.run_steer_replay_failed", {
      runId: context.id,
      organizationId: context.organizationId,
      pendingChars: pendingSteer.length,
      error: describe(error),
    });
  }
}

/**
 * Hermes 0.23 `unknown`: closes the lost turn so the session's next turns can
 * start. A run without its admission pair, or a refused call, is logged and
 * left to Hermes: the run is still counted as interrupted here.
 */
export async function resolveUnknownTurn(
  client: Pick<HermesClient, "resolveUnknownRun">,
  hermesRunId: string,
  details: Pick<HermesRunDetails, "admissionId" | "executionGeneration">,
  signal: AbortSignal,
  onFailure: (code: string) => void,
): Promise<boolean> {
  if (!details.admissionId || details.executionGeneration == null) {
    onFailure("HERMES_UNKNOWN_WITHOUT_ADMISSION");
    return false;
  }
  try {
    await client.resolveUnknownRun(hermesRunId, details.admissionId, details.executionGeneration, signal);
    return true;
  } catch (error) {
    onFailure(error instanceof HermesClientError ? error.code : "HERMES_RESOLVE_UNKNOWN_FAILED");
    return false;
  }
}
