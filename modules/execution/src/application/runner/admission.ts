import type { SQL } from "bun";
import type { HermesClient } from "@openedbot/hermes";
import type { RunTrace } from "@openedbot/platform-observability/run-trace";
import { createRuntimeClient } from "../runtime-client";
import type { WorkerConfig } from "../worker-config";
import { NamedRunError, handleFailure } from "./failure";
import type { RunContext } from "./types";
import { log } from "./util";

/**
 * Préflight, first half: what refuses a claimed run before any Hermes call,
 * then the client it runs on. Returns null once the run is failed (named
 * error) and nothing else may happen. Writes `context.workflowStatus` when
 * the workflow leaves `queued`.
 */
export async function admitClaimedRun(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  trace: Pick<RunTrace, "span">,
): Promise<HermesClient | null> {
  const importing = await trace.span("preflight.import_check", () => db<Array<{ slug: string }>>`
    select slug from profile_import_items where organization_id = ${context.organizationId}
      and bot_id = ${context.botId} and reservation_released_at is null limit 1
  `);
  if (importing.length) {
    await handleFailure(db, config, context, new NamedRunError("PROFILE_IMPORT_IN_PROGRESS", "Ce profil est encore en cours d’import ou à vérifier dans les réglages Hermes."));
    return null;
  }
  // PERM2-2: under `v2` the pipeline only sees the writes the host submits.
  // A plugin not proven in the bot's mode (restart pending, older host,
  // reconciliation not done yet) would let them through: no run starts.
  if (context.hostPolicyRequired && !context.hostPolicyProven) {
    await handleFailure(db, config, context, new NamedRunError(
      "PERMISSION_POLICY_NOT_EFFECTIVE",
      "Les permissions de ce bot ne sont pas encore actives sur votre serveur. Si un redémarrage du gateway est proposé, lancez-le depuis les réglages du bot, dans « Règles d’approbation », puis renvoyez votre message.",
    ));
    return null;
  }
  if (context.workflowId && context.stackDepth > 0 && !context.callerBotId) {
    await handleFailure(db, config, context, new NamedRunError(
      "WORKFLOW_CALLER_MISSING",
      "Le bot appelant n’existe plus; la chaîne ne peut pas reprendre sans risquer une synthèse incorrecte.",
    ));
    return null;
  }
  if (context.workflowId) {
    // The first real start gives the workflow a fresh execution budget: the
    // time it spent queued (capacity, runtime) was bounded by its admission
    // grace (domain/workflow-admission.ts), not by this budget. The new
    // deadline is read back into the context: `readContext` ran before, and
    // the deadline check and the supervision timers that follow read it.
    // A lease that already expired writes nothing (0002, §9.3).
    const [admitted] = await trace.span("preflight.workflow_running", () => db<Array<{
      status: string; deadlineAt: Date | string;
    }>>`
      update workflows workflow set
        status = case when workflow.status = 'queued' then 'running' else workflow.status end,
        started_at = coalesce(workflow.started_at, now()),
        deadline_at = case when workflow.started_at is null
          then now() + (workflow.timeout_seconds * interval '1 second')
          else workflow.deadline_at end,
        updated_at = now()
       where workflow.organization_id = ${context.organizationId} and workflow.id = ${context.workflowId}
         and (
           workflow.status = 'queued'
           or (workflow.started_at is null and workflow.status in ('running','awaiting_approval'))
         )
         and exists (
           select 1 from runs run where run.organization_id = ${context.organizationId} and run.id = ${context.id}
             and run.lease_owner = ${config.workerId} and run.lease_generation = ${context.leaseGeneration}
             and run.status = 'starting' and run.lease_expires_at > now()
         )
      returning workflow.status, workflow.deadline_at as "deadlineAt"
    `);
    if (admitted) {
      context.workflowStatus = admitted.status;
      context.workflowDeadlineAt = admitted.deadlineAt;
    } else if (context.workflowStatus === "queued") {
      context.workflowStatus = "running";
    }
  }
  try {
    const client = createRuntimeClient(context, config);
    log("worker.runtime_transport", { runId: context.id, runtimeId: context.runtimeId, transport: context.reachability === "direct" ? "direct" : "relay", profile: context.reachability === "direct" ? null : context.hermesProfile });
    return client;
  } catch {
    await handleFailure(db, config, context, new NamedRunError(
      "RUNTIME_CREDENTIALS_MISSING",
      "Le runtime n’a pas d’identifiants exploitables. Restaurez la clé de chiffrement ou remplacez les accès.",
    ));
    return null;
  }
}

/**
 * A workflow past its deadline fails before this step starts. A
 * reconciliation is exempt: it only settles what already ran.
 */
export function workflowDeadlinePassed(
  context: Pick<RunContext, "workflowStatus" | "workflowDeadlineAt">,
  now: number,
): boolean {
  if (context.workflowStatus === "reconciling" || !context.workflowDeadlineAt) return false;
  return new Date(context.workflowDeadlineAt).getTime() <= now;
}

/**
 * Time left to the workflow's deadline, which bounds the run's timeout. A
 * reconciliation, or a run outside a workflow, is bounded by its own timeout.
 */
export function workflowRemainingMs(
  context: Pick<RunContext, "workflowStatus" | "workflowDeadlineAt">,
  now: number,
): number {
  return context.workflowDeadlineAt && context.workflowStatus !== "reconciling"
    ? new Date(context.workflowDeadlineAt).getTime() - now
    : Number.POSITIVE_INFINITY;
}
