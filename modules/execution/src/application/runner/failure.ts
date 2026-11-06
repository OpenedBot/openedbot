import type { SQL } from "bun";
import { MODEL_UNAVAILABLE_CODE } from "@openedbot/contracts-errors";
import { HermesClientError, type HermesClient } from "@openedbot/hermes";
import type { OrganizationEvent } from "@openedbot/contracts-events";
import type { WorkerConfig } from "../worker-config";
import { MAX_RUN_ATTEMPTS } from "../queue";
import { isModelUnavailableFailure } from "../../domain/provider-failure";
import { appendNoticeTx, publish } from "./events";
import { persistUnnumberedEvents } from "./persist";
import { RunEventSequenceConflictError } from "../../domain/run-event-sequence";
import type { RunContext } from "./types";
import { describe, log } from "./util";

export function shouldRetryHermesRun(error: unknown, attempts: number): boolean {
  if (attempts >= MAX_RUN_ATTEMPTS || !(error instanceof HermesClientError)) return false;
  // The gateway's concurrent-run cap answered 429 before creating anything:
  // it clears on its own, so the run waits its turn (at least 10 s, see
  // `retryDelaySeconds`) instead of failing or blaming the provider.
  if (error.code === "HERMES_LIMIT_REACHED") return error.requestDelivery === "response_received";
  // A gateway restarting gracefully refuses new runs while it finishes the
  // running ones, before creating anything: the run waits for the new one.
  if (error.code === "HERMES_GATEWAY_DRAINING") return error.requestDelivery === "response_received";
  return error.requestDelivery === "not_sent" && error.code === "HERMES_UNREACHABLE";
}

/**
 * How long a draining gateway may hold a run back without spending its
 * attempts: past Hermes' own `restart_after_turn_timeout` (30 min), with a
 * margin for the relaunch. Older runs fall back to the ordinary attempt cap.
 */
export const DRAINING_PATIENCE_MINUTES = 35;

/**
 * How long a gateway that nothing reached (refused dial, link not there) may
 * hold a run back without spending its attempts. Measured 2026-10-31 on the
 * lab host: a graceful restart left the api_server closed for 16 s, which
 * cost a run 3 of its 5 attempts; a cold host takes up to 90 s
 * (`HealthTimeout`). A gateway down longer falls back to the attempt cap.
 */
export const RELAUNCH_PATIENCE_MINUTES = 2;

/** Minutes a requeue hands its attempt back for, 0 when it spends it. */
export function attemptPatienceMinutes(error: HermesClientError): number {
  if (error.code === "HERMES_GATEWAY_DRAINING") return DRAINING_PATIENCE_MINUTES;
  if (error.code === "HERMES_UNREACHABLE" && error.requestDelivery === "not_sent") return RELAUNCH_PATIENCE_MINUTES;
  return 0;
}

/**
 * Backoff exponentiel plafonné + jitter. Un 429 (saturation) attend au moins
 * 10 s. Un gateway qui redémarre est revu toutes les 3 s environ : la relance
 * ne dure que quelques secondes une fois ses runs finis.
 */
export function retryDelaySeconds(error: HermesClientError, attempts: number): number {
  const retryAfterSeconds = error.retryAfterMs === null ? 0 : Math.ceil(error.retryAfterMs / 1_000);
  if (error.code === "HERMES_GATEWAY_DRAINING") return Math.max(3, retryAfterSeconds) + Math.random();
  const base = Math.min(60, 2 ** Math.min(attempts, 6));
  const floor = error.code === "HERMES_LIMIT_REACHED" ? 10 : 0;
  return Math.max(base, floor, retryAfterSeconds) + Math.random();
}

export class NamedRunError extends Error {
  /**
   * `details` joins the `run.error` payload next to `message` and
   * `errorCode`: bounded product fields the console reads (the provider to
   * reconnect), never an upstream text.
   */
  constructor(readonly code: string, message: string, readonly details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "NamedRunError";
  }
}

export async function markRunUnknown(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  code: string,
  message: string,
): Promise<boolean> {
  const result = await db.begin(async (tx) => {
    const rows = await tx<Array<{ workflowId: string | null }>>`
      update runs set status = 'unknown', external_state = 'ambiguous', events_complete = false,
        remote_stop_state = case
          when remote_stop_state in ('requested','confirmed','failed') then 'ambiguous'
          else remote_stop_state
        end,
        error_code = ${code}, error_message = ${message}, lease_owner = null, lease_expires_at = null,
        updated_at = now()
       where id = ${context.id} and organization_id = ${context.organizationId}
         and lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
         and status in ('starting','running','awaiting_approval')
       returning workflow_id as "workflowId"
    `;
    const row = rows[0];
    if (!row) return null;
    if (row.workflowId) {
      await tx`
        update workflows set status = 'unknown', error_code = ${code}, error_message = ${message},
          recovery_state = ${{ runId: context.id, needsReview: true }}, updated_at = now()
         where organization_id = ${context.organizationId} and id = ${row.workflowId}
      `;
    }
    const envelope = await appendNoticeTx(tx, context, {
      message: "Résultat Hermes incertain : vérification requise avant toute relance.",
      kind: "workflow.needs_review",
      errorCode: code,
      workflowId: row.workflowId,
      recoveryState: "needs_review",
    });
    return { row, envelope };
  }) as { row: { workflowId: string | null }; envelope: OrganizationEvent | null } | null;
  const row = result?.row;
  if (!row) return false;
  if (result.envelope) await publish(config, result.envelope);
  log("worker.run_unknown", {
    runId: context.id,
    organizationId: context.organizationId,
    workflowId: row.workflowId,
    code,
  });
  return true;
}

/**
 * Le code public d'un échec de tour. Un 400 du fournisseur arrive en
 * `HERMES_RESPONSE_INVALID` : le motif « modèle refusé » ne vit que dans
 * `diagnostic` (jamais persisté), on le lit ici pour poser le code stable
 * sans exposer le texte amont.
 */
export function failureCode(error: unknown): string {
  if (error instanceof HermesClientError) {
    return isModelUnavailableFailure({ status: error.status, message: error.diagnostic ?? "" })
      ? MODEL_UNAVAILABLE_CODE
      : error.code;
  }
  return error instanceof NamedRunError || error instanceof RunEventSequenceConflictError ? error.code : "WORKER_RUN_FAILED";
}

export async function handleFailure(db: SQL, config: WorkerConfig, context: RunContext, error: unknown): Promise<void> {
  if (
    error instanceof HermesClientError &&
    (
      error.code === "HERMES_CREATE_AMBIGUOUS" ||
      (context.externalState === "creating" && error.status >= 500 && error.code !== "HERMES_LIMIT_REACHED" &&
        error.code !== "HERMES_GATEWAY_DRAINING" && error.requestDelivery !== "not_sent")
    )
  ) {
    await markRunUnknown(db, config, context, error.code, error.message);
    return;
  }
  const safePrerequisiteRetry = error instanceof HermesClientError &&
    context.externalState === "not_started" && error.code === "HERMES_UNREACHABLE" &&
    context.attempts < MAX_RUN_ATTEMPTS;
  if (error instanceof HermesClientError && (safePrerequisiteRetry || shouldRetryHermesRun(error, context.attempts))) {
    const delaySeconds = retryDelaySeconds(error, context.attempts);
    // A gateway draining or relaunching is not a failed attempt: the claim's
    // increment is handed back, within a bounded patience so a gateway stuck
    // there still ends the run.
    const patienceMinutes = attemptPatienceMinutes(error);
    await db`
      update runs set status = 'queued', lease_owner = null, lease_expires_at = null,
        attempts = case
          when ${patienceMinutes} > 0 and created_at > now() - (${patienceMinutes} * interval '1 minute')
            then greatest(attempts - 1, 0)
          else attempts
        end,
        next_attempt_at = now() + (${delaySeconds} * interval '1 second'),
        external_state = case when hermes_run_id is null then 'not_started' else 'polling' end,
        error_code = ${error.code}, error_message = ${error.message}, updated_at = now()
       where id = ${context.id} and organization_id = ${context.organizationId}
         and lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
         and status in ('starting','running','awaiting_approval')
    `;
    return;
  }
  const code = failureCode(error);
  const message = error instanceof Error ? error.message : "Le worker n’a pas pu exécuter le run.";
  // Un échec sans événement est un fil MUET : le client ne lit que run_events,
  // jamais runs.error_code. Le même chemin transactionnel finalise le run,
  // avance exactement une fois un salon et livre exactement une fois un hand-off.
  const existing = await db<Array<{ id: string }>>`
    select 1 as id from run_events
     where organization_id = ${context.organizationId} and run_id = ${context.id} and type = 'run.error'
     limit 1
  `;
  if (!existing[0]) {
    await persistUnnumberedEvents(db, config, context, context.lastHermesSequence, [{
      type: "run.error",
      occurredAt: new Date(),
      payload: { ...(error instanceof NamedRunError ? error.details : {}), message, errorCode: code },
    }]);
  }
  // Le diagnostic upstream n'est ni persisté, ni journalisé : il peut contenir
  // un secret ou du contenu privé. `reference` est la seule chose que les deux
  // surfaces partagent.
  log("worker.run_failed", {
    runId: context.id,
    organizationId: context.organizationId,
    code,
    error: message,
    ...(error instanceof HermesClientError && error.reference ? { reference: error.reference } : {}),
  });
}

/**
 * Un run de service d'un genre retiré (`memory` : l'extraction openedbot, 07-09).
 * Une ligne ancienne encore en file ne doit pas partir vers Hermes.
 */
export function retiredServiceStep(kind: string | null): never {
  throw new NamedRunError("SERVICE_STEP_RETIRED", `Le run de service « ${kind ?? "?"} » n'existe plus.`);
}

/**
 * Hermes a créé un run (premier envoi ou repli) mais le bail local s'est
 * perdu avant que son identifiant soit confirmé : on tente l'arrêt, puis on
 * garde l'identifiant sur une ligne `unknown` à réconcilier.
 */
export async function settleOrphanCreate(db: SQL, context: RunContext, client: HermesClient, hermesRunId: string): Promise<void> {
  let remoteStopState: "confirmed" | "ambiguous" = "ambiguous";
  try {
    await client.stopRun(hermesRunId);
    remoteStopState = "confirmed";
  } catch (error) {
    log("worker.orphan_create_stop_unconfirmed", {
      runId: context.id,
      hermesRunId,
      error: describe(error),
    });
  }
  await db.begin(async (tx) => {
    const rows = await tx<Array<{ workflowId: string | null }>>`
      update runs set hermes_run_id = coalesce(hermes_run_id, ${hermesRunId}),
        status = 'unknown', external_state = ${remoteStopState === "confirmed" ? "polling" : "ambiguous"},
        remote_stop_state = ${remoteStopState}, events_complete = false,
        error_code = 'HERMES_CREATE_COMMIT_LOST',
        error_message = 'Hermes a créé le run mais le lease local a été perdu avant la confirmation.',
        lease_owner = null, lease_expires_at = null, ended_at = null, updated_at = now()
       where id = ${context.id} and organization_id = ${context.organizationId}
         and status in ('starting','running','awaiting_approval','unknown')
       returning workflow_id as "workflowId"
    `;
    if (rows[0]?.workflowId) await tx`
      update workflows set status = 'unknown', error_code = 'HERMES_CREATE_COMMIT_LOST',
        error_message = 'Le run Hermes existe mais sa création locale doit être réconciliée.',
        recovery_state = ${{
          runId: context.id,
          needsReview: true,
          action: "reconcile_or_abandon",
          hermesRunIdAvailable: true,
        }}, ended_at = null, updated_at = now()
       where organization_id = ${context.organizationId} and id = ${rows[0].workflowId}
         and status not in ('completed','failed','expired')
    `;
  });
}
