import type { SQL } from "bun";
import { type HermesClient, HermesClientError, type HermesRunDetails } from "@openedbot/hermes";
import { FOLLOWUP_SUPERSEDE_CODE } from "@openedbot/contracts-errors";
import { insertAssistantMessage } from "@openedbot/conversation/sql/messages";
import { isServiceStepKind } from "../../domain/run-step";
import type { OrganizationEvent } from "@openedbot/contracts-events";
import type { WorkerConfig } from "../worker-config";
import { MAX_RUN_ATTEMPTS } from "../queue";
import { expireUnacknowledgedRunSteers } from "../run-steering";
import {
  FOLLOWUP_SUPERSEDE_MESSAGE,
  SUPERSEDED_COMPLETION_KIND,
  SUPERSEDED_NOTICE_KIND,
} from "@openedbot/conversation/domain/followup";
import { appendEventTx, appendRunErrorTx, publishBatch } from "./events";
import { markRunUnknown, retryDelaySeconds } from "./failure";
import { deliverHandoffReplyTx } from "./handoff";
import { assistantMessageForCompletion, groupSendState } from "./rooms";
import type { RunContext } from "./types";
import { pollWait } from "./util";
import { ACTIVE_RUN_STATUSES } from "../../domain/run-transitions";
import { NOW, RELEASE_LEASE, sqlExpr, transitionRuns } from "../../sql/run-transitions";
import { confirmRemoteStop, heldLease, markRemoteStopAmbiguous, requestRemoteStop, runKey } from "./lease-transitions";

export function requestedCancellationRecoveryMode(
  externalState: RunContext["externalState"],
): "send_stop" | "reconcile_only" {
  // `polling + requested` is persisted by lease recovery after a worker had
  // already crossed the POST /stop boundary. Whether that POST arrived is no
  // longer knowable, so only the idempotent status read may be resumed.
  return externalState === "polling" ? "reconcile_only" : "send_stop";
}

/** Rebuilds the part already flushed before Hermes acknowledged cancellation. */
export function cancelledOutputFromEvents(
  events: readonly { sequence: number; payload: unknown }[],
  fallback: string | null,
): string {
  const streamed = [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => {
      if (!event.payload || typeof event.payload !== "object") return "";
      const text = (event.payload as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
  return streamed.trim() ? streamed : (fallback ?? "");
}

/**
 * A user cancellation is not terminal until Hermes' terminal state is known.
 * The POST /stop boundary follows the same delivery rule as every consequential
 * mutation: only a proven `not_sent` failure is retried automatically.
 */
export async function processRequestedCancellation(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  hermesRunId: string | null,
): Promise<void> {
  if (!hermesRunId) {
    await markRunUnknown(
      db,
      config,
      context,
      "HERMES_STOP_WITHOUT_RUN_ID",
      "L’arrêt a été demandé après un effet Hermes possible, sans identifiant réconciliable.",
    );
    return;
  }

  if (!await requestRemoteStop(db, config, context)) return;
  context.externalState = "stopping";

  try {
    await client.stopRun(hermesRunId);
  } catch (error) {
    if (
      error instanceof HermesClientError &&
      error.requestDelivery === "not_sent" &&
      context.attempts < MAX_RUN_ATTEMPTS
    ) {
      const delaySeconds = retryDelaySeconds(error, context.attempts);
      await transitionRuns(db, {
        target: runKey(context), fence: heldLease(config, context),
        transition: { from: ACTIVE_RUN_STATUSES, to: { status: "queued", externalState: "stopping", remoteStopState: "requested" } },
        set: {
          ...RELEASE_LEASE, nextAttemptAt: sqlExpr`now() + (${delaySeconds} * interval '1 second')`,
          errorCode: sqlExpr`coalesce(error_code, 'CANCEL_REQUESTED')`,
          errorMessage: sqlExpr`coalesce(error_message, 'Annulation en attente de transmission à Hermes.')`,
        },
      });
      return;
    }
    await markRemoteStopAmbiguous(db, config, context);
    await markRunUnknown(
      db,
      config,
      context,
      "HERMES_STOP_OUTCOME_UNKNOWN",
      error instanceof Error ? error.message : "L’arrêt Hermes n’a pas pu être confirmé.",
    );
    return;
  }

  if (!await confirmRemoteStop(db, config, context)) return;
  context.externalState = "polling";
  context.remoteStopState = "confirmed";

  await reconcileRequestedCancellation(db, config, context, client, hermesRunId);
}

export async function reconcileRequestedCancellation(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  hermesRunId: string,
): Promise<void> {
  const pollController = new AbortController();
  const timeout = setTimeout(
    () => pollController.abort("cancellation_reconciliation_timeout"),
    config.reconciliationTimeoutMs,
  );
  try {
    const details = await waitForHermesTerminal(client, hermesRunId, pollController.signal);
    if (!details) {
      await markRunUnknown(
        db,
        config,
        context,
        "HERMES_STOP_RECONCILIATION_TIMEOUT",
        "L’issue de la demande d’arrêt est incertaine et aucun état terminal n’a pu être confirmé.",
      );
      return;
    }
    await settleRequestedCancellation(db, config, context, details);
  } catch (error) {
    await markRunUnknown(
      db,
      config,
      context,
      error instanceof HermesClientError ? error.code : "HERMES_STOP_RECONCILIATION_FAILED",
      error instanceof Error ? error.message : "L’état terminal après arrêt Hermes est illisible.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHermesTerminal(
  client: HermesClient,
  hermesRunId: string,
  signal: AbortSignal,
): Promise<HermesRunDetails | null> {
  let delayMs = 500;
  while (!signal.aborted) {
    try {
      const details = await client.getRunStatus(hermesRunId, signal);
      if (["completed", "failed", "interrupted", "cancelled"].includes(details.status)) return details;
    } catch (error) {
      if (signal.aborted) break;
      if (!(error instanceof HermesClientError) || error.code !== "HERMES_UNREACHABLE") throw error;
    }
    await pollWait(delayMs, signal);
    delayMs = Math.min(5_000, delayMs * 2);
  }
  return null;
}

async function settleRequestedCancellation(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  details: HermesRunDetails,
): Promise<void> {
  // Remplacé par le message suivant (politique de rafale) : le run s'arrête
  // sans erreur, son message reste dans le fil, et le repère est muet.
  const result = await db.begin(async (tx) => {
    const locked = context.workflowId
      ? await tx<Array<{ id: string }>>`
          select id from runs
           where organization_id = ${context.organizationId} and workflow_id = ${context.workflowId}
           order by id for update
        `
      : await tx<Array<{ id: string }>>`
          select id from runs
           where organization_id = ${context.organizationId} and id = ${context.id}
           for update
        `;
    if (!locked.some((run) => run.id === context.id)) return null;
    if (context.workflowId) await tx`
      select id from workflows
       where organization_id = ${context.organizationId} and id = ${context.workflowId}
       for update
    `;
    // La raison vit en base, posée par l'API avec la demande d'arrêt. Le
    // runner ne la relit que sur son battement ou en fin de flux ; un arrêt
    // signalé par le concentrateur (`cancellation-watch`) arrive avant, et le
    // contexte porte encore la raison nulle du claim : sans cette relecture,
    // un run remplacé par le message suivant se réglait en « Run annulé. ».
    const persisted = await tx<Array<{ errorCode: string | null; errorMessage: string | null }>>`
      select error_code as "errorCode", error_message as "errorMessage" from runs
       where organization_id = ${context.organizationId} and id = ${context.id}
    `;
    const errorCode = context.errorCode ?? persisted[0]?.errorCode ?? "CANCELLED_BY_USER";
    const errorMessage = context.errorMessage ?? persisted[0]?.errorMessage ?? "Run annulé.";
    const partialEvents = await tx<Array<{ sequence: number; payload: unknown }>>`
      select sequence, payload from run_events
       where organization_id = ${context.organizationId} and run_id = ${context.id}
         and type = 'agent.message'
       order by sequence asc
    `;
    const cancelledOutput = cancelledOutputFromEvents(partialEvents, details.output);
    // Remplacé par le message suivant (politique de rafale) : le run s'arrête
    // sans erreur, son message reste dans le fil, et le repère est muet.
    const superseded = errorCode === FOLLOWUP_SUPERSEDE_CODE;
    const fenced = await transitionRuns(tx as unknown as SQL, {
      target: runKey(context), fence: heldLease(config, context),
      transition: { from: ACTIVE_RUN_STATUSES, to: { status: "cancelled", externalState: "settled", remoteStopState: "confirmed" } },
      set: {
        output: cancelledOutput || null, usage: details.usage, eventsComplete: true,
        completionKind: superseded ? SUPERSEDED_COMPLETION_KIND : `cancelled_after_${details.status}`,
        errorCode, errorMessage, endedAt: NOW, ...RELEASE_LEASE,
      },
    });
    if (!fenced[0]) return null;
    const partialMessage = !superseded && !isServiceStepKind(context.stepKind)
      ? assistantMessageForCompletion(cancelledOutput, groupSendState(context))
      : null;
    if (partialMessage) {
      const existing = await tx<Array<{ id: string }>>`
        select id from messages
         where organization_id = ${context.organizationId} and run_id = ${context.id}
           and role = 'assistant'
         limit 1
      `;
      if (!existing[0]) {
        await insertAssistantMessage(tx, {
          messageId: crypto.randomUUID(),
          organizationId: context.organizationId,
          threadId: context.threadId,
          runId: context.id,
          content: [{ type: "text", text: partialMessage }],
          authorBotId: context.groupTurnPosition !== null || context.workflowId ? context.botId : null,
        });
      }
    }
    await tx`
      update approval_requests set
        status = case when status = 'pending' then 'expired' else status end,
        forward_state = case when forward_state = 'confirmed' then forward_state else 'expired' end,
        resolved_at = coalesce(resolved_at, now()), forwarding_owner = null,
        forwarding_lease_expires_at = null
       where organization_id = ${context.organizationId} and run_id = ${context.id}
         and (status = 'pending' or forward_state in ('pending','ready','sending'))
    `;
    if (context.workflowId) {
      const workflowTerminalStatus = errorCode === "WORKFLOW_DEADLINE_EXCEEDED" ? "expired" : "cancelled";
      // The workflow's steps that never started: no lease to hold.
      await transitionRuns(tx as unknown as SQL, {
        target: { organizationId: context.organizationId, workflowId: context.workflowId }, fence: "unleased",
        transition: { from: ["queued"], fromExternalState: ["not_started"], to: { status: "cancelled", externalState: "settled" } },
        set: {
          eventsComplete: true, errorCode,
          errorMessage: context.errorMessage ?? persisted[0]?.errorMessage ?? "Workflow annulé.", endedAt: NOW, ...RELEASE_LEASE,
        },
      });
      await tx`
        update workflows set status = ${workflowTerminalStatus},
          error_code = ${errorCode},
          error_message = ${context.errorMessage ?? persisted[0]?.errorMessage ?? "Workflow annulé."},
          recovery_state = ${{ cancelRequested: true, remoteStatus: details.status }},
          ended_at = now(), updated_at = now()
         where organization_id = ${context.organizationId} and id = ${context.workflowId}
           and status in ('queued','running','awaiting_approval','reconciling')
      `;
    }
    const envelope = superseded
      ? await appendEventTx(tx, context, "system.notice", {
          message: errorMessage || FOLLOWUP_SUPERSEDE_MESSAGE,
          kind: SUPERSEDED_NOTICE_KIND,
        })
      : await appendRunErrorTx(tx, context, errorMessage, errorCode);
    const handoff = context.originRunId
      ? await deliverHandoffReplyTx(tx, context, {
          status: "cancelled",
          output: null,
          error: errorMessage,
        })
      : [];
    return { envelope, handoff };
  }) as { envelope: OrganizationEvent | null; handoff: OrganizationEvent[] } | null;
  if (!result) return;
  await publishBatch(config, [...(result.envelope ? [result.envelope] : []), ...result.handoff]);
  await expireUnacknowledgedRunSteers(db, {
    id: context.id,
    organizationId: context.organizationId,
  });
}
