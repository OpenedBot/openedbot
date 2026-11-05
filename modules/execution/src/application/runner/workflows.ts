import type { SQL } from "bun";
import type { HermesClient, HermesSessionCounters } from "@openedbot/hermes";
import {
  HANDOFF_NOTICE_KIND,
  attributedInput,
  handoffSentNotice,
  mentionsUser,
  parseMentions,
  splitHandoff,
  type BotIdentity,
} from "@openedbot/roster/domain/bot-mode";
import {
  canDelegate,
  delegationRefusalMessage,
  workflowSessionKey,
  type WorkflowBudget,
} from "@openedbot/roster/domain/autonomous-workflow";
import type { OrganizationEvent } from "@openedbot/contracts-events";
import type { WorkerConfig } from "../worker-config";
import { appendNoticeTx } from "./events";
import { handoffRoster } from "./handoff";
import type { RunContext, WorkflowFailureContext } from "./types";
import { describe, log } from "./util";

/** A workflow snapshot is an immutable ceiling; the current bot flag can only reduce it. */
export function workflowAutonomyAllowsDelegation(
  workflowSnapshotEnabled: boolean | null | undefined,
  currentBotEnabled: boolean,
): boolean {
  return workflowSnapshotEnabled === true && currentBotEnabled;
}

/** Keep forbidden targets recognizable so a directive gets an explicit refusal. */
async function workflowDirectiveRoster(db: SQL, organizationId: string): Promise<Array<BotIdentity & { active: boolean }>> {
  return db<Array<BotIdentity & { active: boolean }>>`
    select b.id, b.name, b.slug, b.description, coalesce(t.id::text, '') as "threadId",
           (b.archived_at is null and t.id is not null) as active
      from bots b
      left join threads t on t.organization_id = b.organization_id and t.bot_id = b.id and t.is_default
     where b.organization_id = ${organizationId}
     order by b.id
  `;
}

/** Read at the authorization point, without taking a bot lock after a run lock. */
export async function currentCoordinationEnabled(db: SQL, organizationId: string, botId: string): Promise<boolean> {
  const rows = await db<Array<{ enabled: boolean }>>`
    select autonomy_enabled as enabled from bots
     where organization_id = ${organizationId} and id = ${botId} and archived_at is null
  `;
  return rows[0]?.enabled === true;
}

type StoredWorkflow = {
  id: string;
  status: string;
  autonomyEnabled: boolean;
  maxDepth: number;
  maxSteps: number;
  maxHandoffs: number;
  tokenBudget: string | number;
  usedSteps: number;
  usedHandoffs: number;
  usedTokens: string | number;
  deadlineAt: Date | string;
};

/** Advances one serial DM workflow after a successful step. */
export async function advanceWorkflowCompletionTx(
  tx: SQL,
  context: RunContext,
  output: string,
): Promise<OrganizationEvent[]> {
  if (!context.workflowId || context.groupId) return [];
  const rows = await tx<StoredWorkflow[]>`
    select id, status, autonomy_enabled as "autonomyEnabled", max_depth as "maxDepth", max_steps as "maxSteps",
           max_handoffs as "maxHandoffs", token_budget as "tokenBudget",
           used_steps as "usedSteps", used_handoffs as "usedHandoffs", used_tokens as "usedTokens",
           deadline_at as "deadlineAt"
      from workflows where organization_id = ${context.organizationId} and id = ${context.workflowId}
     for update
  `;
  const workflow = rows[0];
  if (!workflow || ["completed", "failed", "cancelled", "expired", "unknown"].includes(workflow.status)) return [];
  if (!output.trim()) {
    await tx`
      update runs set completion_kind = 'empty_output', updated_at = now()
       where organization_id = ${context.organizationId} and id = ${context.id}
    `;
    return advanceWorkflowFailureTx(
      tx,
      context,
      "L’étape s’est terminée sans produire de résultat exploitable.",
      "WORKFLOW_EMPTY_OUTPUT",
    );
  }
  const roster = await workflowDirectiveRoster(tx, context.organizationId);
  const terminalDirective = /(?:^|\n)@([a-z0-9][a-z0-9_-]{0,62})[ \t]+([^\n]+)$/i.exec(output.trimEnd());
  if (terminalDirective && !mentionsUser(terminalDirective[0], context.operator)
    && !roster.some((bot) => bot.slug.toLowerCase() === terminalDirective[1]!.toLowerCase())) {
    // Recognize an unlisted directive for refusal; this sentinel can never be dispatched.
    roster.push({ id: "unlisted", name: terminalDirective[1]!, slug: terminalDirective[1]!,
      description: null, threadId: "", active: false });
  }
  const mention = parseMentions(output, roster, { selfBotId: context.botId, mode: "bot", includeSelf: true });
  const split = mention ? splitHandoff(output, roster) : { body: output, handoff: null };
  const result: OrganizationEvent[] = [];

  if (mention) {
    const callStack = await workflowCallStack(tx, context);
    const decision = canDelegate({
      policyEnabled: workflowAutonomyAllowsDelegation(
        workflow.autonomyEnabled,
        await currentCoordinationEnabled(tx, context.organizationId, context.botId),
      ),
      selfBotId: context.botId,
      targetBotId: mention.botId,
      targetActive: roster.find((bot) => bot.id === mention.botId)?.active === true,
      activeCallStackBotIds: callStack,
      stackDepth: context.stackDepth,
      budget: workflowBudget(workflow),
    });
    if (decision.accepted) {
      const childId = crypto.randomUUID();
      await tx`
        insert into runs (
          id, organization_id, thread_id, bot_id, input, status, workflow_id, step_index, step_kind,
          stack_depth, caller_bot_id, caller_run_id, execution_session_key, external_state, events_complete
        ) values (
          ${childId}, ${context.organizationId}, ${context.threadId}, ${mention.botId},
          ${attributedInput({ name: context.botName, slug: context.botSlug }, mention.message)},
          'queued', ${workflow.id}, ${workflow.usedSteps}, 'delegated',
          ${context.stackDepth + 1}, ${context.botId}, ${context.id},
          ${workflowSessionKey(context.organizationId, workflow.id, mention.botId)}, 'not_started', true
        )
      `;
      await tx`
        update runs set completion_kind = 'delegated', output = ${split.body.trim() || null}, updated_at = now()
         where organization_id = ${context.organizationId} and id = ${context.id}
      `;
      await tx`
        update workflows set status = 'running', used_steps = used_steps + 1,
          used_handoffs = used_handoffs + 1, updated_at = now()
         where organization_id = ${context.organizationId} and id = ${workflow.id}
      `;
      const notice = await appendNoticeTx(tx, context, {
        message: handoffSentNotice(mention),
        kind: HANDOFF_NOTICE_KIND.sent,
        targetBotId: mention.botId,
        workflowId: workflow.id,
        childRunId: childId,
        targetSlug: mention.slug,
        targetName: mention.name,
      });
      if (notice) result.push(notice);
      return result;
    }

    const refusal = await appendNoticeTx(tx, context, {
      message: delegationRefusalMessage(decision.reason),
      kind: "workflow.delegation_refused",
      reason: decision.reason,
      targetBotId: mention.botId === "unlisted" ? null : mention.botId,
      targetSlug: mention.slug,
      targetName: mention.name,
      workflowId: workflow.id,
    });
    if (refusal) result.push(refusal);
    if (!split.body.trim()) {
      await tx`
        update workflows set status = 'failed', error_code = 'WORKFLOW_DELEGATION_REFUSED_EMPTY',
          error_message = ${delegationRefusalMessage(decision.reason)}, ended_at = now(), updated_at = now()
         where organization_id = ${context.organizationId} and id = ${workflow.id}
      `;
      await tx`
        update runs set completion_kind = 'delegation_refused', updated_at = now()
         where organization_id = ${context.organizationId} and id = ${context.id}
      `;
      return result;
    }
  }

  const completion = (mention ? split.body : output).trim();
  if (new Date(workflow.deadlineAt).getTime() <= Date.now()) {
    await tx`
      update workflows set status = 'expired', error_code = 'WORKFLOW_DEADLINE_EXCEEDED',
        error_message = 'La durée maximale du workflow est atteinte.', ended_at = now(), updated_at = now()
       where organization_id = ${context.organizationId} and id = ${workflow.id}
    `;
    return result;
  }
  if (context.callerBotId) {
    const resumed = await createWorkflowContinuationTx(tx, context, workflow, {
      input: `Result returned by 🤖 ${context.botName} (@${context.botSlug}):\n${completion || "(no result)"}\n\nResume the workflow now. Incorporate this result and either answer or make one bounded delegation.`,
      completionKind: "child_result",
    });
    if (!resumed) return result;
    const notice = await appendNoticeTx(tx, context, {
      message: `Résultat de 🤖 ${context.botName} transmis au bot appelant pour synthèse.`,
      kind: "workflow.resuming",
      workflowId: workflow.id,
      continuationRunId: resumed,
      targetBotId: context.callerBotId,
    });
    if (notice) result.push(notice);
    return result;
  }

  await tx`
    update workflows set status = 'completed', final_output = ${completion || null},
      ended_at = now(), updated_at = now()
     where organization_id = ${context.organizationId} and id = ${workflow.id}
  `;
  await tx`
    update runs set completion_kind = 'final', output = ${completion || null}, updated_at = now()
     where organization_id = ${context.organizationId} and id = ${context.id}
  `;
  return result;
}

/**
 * Clôt un tour de DM simple comme le faisait son workflow à autonomie coupée :
 * même `completion_kind`, et une directive `@slug` refusée puis signalée,
 * jamais relayée (le courrier historique reste réservé aux runs sans
 * `step_kind`).
 */
export async function settleSimpleDmCompletionTx(
  tx: SQL,
  context: RunContext,
  output: string,
): Promise<OrganizationEvent[]> {
  if (!output.trim()) {
    await tx`
      update runs set completion_kind = 'empty_output', updated_at = now()
       where organization_id = ${context.organizationId} and id = ${context.id}
    `;
    return [];
  }
  const result: OrganizationEvent[] = [];
  let completion = output.trim();
  if (output.includes("@")) {
    const roster = await handoffRoster(tx, context.organizationId, context.botId);
    const mention = parseMentions(output, roster, { selfBotId: context.botId, mode: "bot" });
    if (mention) {
      completion = splitHandoff(output, roster).body.trim();
      const refusal = await appendNoticeTx(tx, context, {
        message: delegationRefusalMessage("AUTONOMY_DISABLED"),
        kind: "workflow.delegation_refused",
        reason: "AUTONOMY_DISABLED",
        targetBotId: mention.botId,
      });
      if (refusal) result.push(refusal);
      if (!completion) {
        await tx`
          update runs set completion_kind = 'delegation_refused', updated_at = now()
           where organization_id = ${context.organizationId} and id = ${context.id}
        `;
        return result;
      }
    }
  }
  await tx`
    update runs set completion_kind = 'final', output = ${completion}, updated_at = now()
     where organization_id = ${context.organizationId} and id = ${context.id}
  `;
  return result;
}

/** A known child failure returns once to its caller; an unknown effect never enters this path. */
export async function advanceWorkflowFailureTx(
  tx: SQL,
  context: WorkflowFailureContext,
  message: string,
  errorCode: string,
): Promise<OrganizationEvent[]> {
  if (!context.workflowId || context.groupId) return [];
  const rows = await tx<StoredWorkflow[]>`
    select id, status, autonomy_enabled as "autonomyEnabled", max_depth as "maxDepth", max_steps as "maxSteps",
           max_handoffs as "maxHandoffs", token_budget as "tokenBudget",
           used_steps as "usedSteps", used_handoffs as "usedHandoffs", used_tokens as "usedTokens",
           deadline_at as "deadlineAt"
      from workflows where organization_id = ${context.organizationId} and id = ${context.workflowId}
     for update
  `;
  const workflow = rows[0];
  if (!workflow || ["cancelled", "unknown", "completed"].includes(workflow.status)) return [];
  if (context.callerBotId && workflow.usedSteps < workflow.maxSteps && new Date(workflow.deadlineAt).getTime() > Date.now()) {
    const continuationId = await createWorkflowContinuationTx(tx, context, workflow, {
      input: `Delegated step failed in 🤖 ${context.botName} (@${context.botSlug}).\nError ${errorCode}: ${message}\n\nResume once. Use a safe fallback or explain the failure; do not blindly repeat the same external action.`,
      completionKind: "child_failed",
    });
    if (continuationId) {
      const notice = await appendNoticeTx(tx, context, {
        message: `Échec connu de 🤖 ${context.botName}; le bot appelant reprend avec un repli explicite.`,
        kind: "workflow.resuming_after_failure",
        workflowId: workflow.id,
        continuationRunId: continuationId,
        targetBotId: context.callerBotId,
        errorCode,
      });
      return notice ? [notice] : [];
    }
  }
  const terminalStatus = errorCode === "WORKFLOW_DEADLINE_EXCEEDED" ? "expired" : "failed";
  await tx`
    update workflows set status = ${terminalStatus}, error_code = ${errorCode}, error_message = ${message},
      ended_at = now(), updated_at = now()
     where organization_id = ${context.organizationId} and id = ${workflow.id}
  `;
  return [];
}

async function createWorkflowContinuationTx(
  tx: SQL,
  context: WorkflowFailureContext,
  workflow: StoredWorkflow,
  completion: { input: string; completionKind: string },
): Promise<string | null> {
  if (!context.callerBotId || workflow.usedSteps >= workflow.maxSteps) {
    await tx`
      update workflows set status = 'failed', error_code = 'WORKFLOW_STEP_LIMIT',
        error_message = 'Aucune étape ne reste pour remonter la chaîne.', ended_at = now(), updated_at = now()
       where organization_id = ${context.organizationId} and id = ${workflow.id}
    `;
    return null;
  }
  const parent = context.callerRunId
    ? (await tx<Array<{ callerBotId: string | null; callerRunId: string | null }>>`
        select caller_bot_id as "callerBotId", caller_run_id as "callerRunId"
          from runs where organization_id = ${context.organizationId} and id = ${context.callerRunId}
      `)[0]
    : null;
  const id = crypto.randomUUID();
  await tx`
    insert into runs (
      id, organization_id, thread_id, bot_id, input, status, workflow_id, step_index, step_kind,
      stack_depth, caller_bot_id, caller_run_id, resumes_run_id, completion_kind,
      execution_session_key, external_state, events_complete
    ) values (
      ${id}, ${context.organizationId}, ${context.threadId}, ${context.callerBotId}, ${completion.input}, 'queued',
      ${workflow.id}, ${workflow.usedSteps}, 'continuation', ${Math.max(0, context.stackDepth - 1)},
      ${parent?.callerBotId ?? null}, ${parent?.callerRunId ?? null}, ${context.callerRunId},
      ${completion.completionKind},
      ${workflowSessionKey(context.organizationId, workflow.id, context.callerBotId)}, 'not_started', true
    )
  `;
  await tx`
    update workflows set status = 'running', used_steps = used_steps + 1, updated_at = now()
     where organization_id = ${context.organizationId} and id = ${workflow.id}
  `;
  return id;
}

async function workflowCallStack(tx: SQL, context: RunContext): Promise<string[]> {
  const rows = await tx<Array<{ botId: string }>>`
    with recursive callers as (
      select id, bot_id, caller_run_id from runs
       where organization_id = ${context.organizationId} and id = ${context.id}
      union all
      select parent.id, parent.bot_id, parent.caller_run_id from runs parent
        join callers child on child.caller_run_id = parent.id
       where parent.organization_id = ${context.organizationId}
    )
    select bot_id as "botId" from callers where bot_id is not null
  `;
  return [...new Set([context.botId, context.callerBotId, ...rows.map((row) => row.botId)].filter(Boolean) as string[])];
}

function workflowBudget(workflow: StoredWorkflow): WorkflowBudget {
  return {
    maxDepth: workflow.maxDepth,
    maxSteps: workflow.maxSteps,
    maxHandoffs: workflow.maxHandoffs,
    timeoutSeconds: Math.max(1, Math.ceil((new Date(workflow.deadlineAt).getTime() - Date.now()) / 1_000)),
    tokenBudget: Number(workflow.tokenBudget),
    usedSteps: workflow.usedSteps,
    usedHandoffs: workflow.usedHandoffs,
    usedTokens: Number(workflow.usedTokens),
    deadlineAt: new Date(workflow.deadlineAt),
  };
}

export function usageTotal(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const total = (value as { totalTokens?: unknown }).totalTokens;
  return typeof total === "number" && Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
}

function usageInput(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const input = (value as { inputTokens?: unknown }).inputTokens;
  return typeof input === "number" && Number.isFinite(input) && input > 0 ? Math.floor(input) : 0;
}

/**
 * Pourquoi le brut ment. Mesuré le 25-08 : un message de quatre
 * mots coûte 14 748 jetons d'entrée, un bloc fixe injecté par la gateway
 * (prompt système, 39 outils, 77 skills) qu'aucun paramètre de requête ne
 * désactive. Ce bloc est mis en cache par le fournisseur et le cache est
 * partagé entre sessions : le deuxième tour ne paie plus que 924 jetons frais
 * et 13 824 relus. L'`usage` de `run.completed` ne connaît pas cette
 * ventilation et facture les 14 748 au prix fort : le budget d'un workflow
 * brûle jusqu'à six fois trop vite, et c'est lui qui coupe les salons et les
 * chaînes de délégation.
 */
type WorkflowTokenAccounting = {
  /** Ce qu'on impute réellement à `workflows.used_tokens`. */
  effectiveTokens: number;
  rawTokens: number;
  /** Jetons d'entrée servis par le cache pendant CETTE étape. */
  cachedTokens: number;
  reason:
    | "cache_discounted"
    | "no_cache"
    | "counters_unavailable"
    | "counters_reset"
    | "counters_out_of_window";
};

/**
 * Coût effectif d'une étape à partir des compteurs CUMULATIFS de la session,
 * lus avant puis après l'étape.
 *
 * Concurrence : une session Hermes est partagée par tous les runs d'un même
 * fil (`threads.hermes_session_id`) et, en workflow, par toutes les étapes d'un
 * même bot (`openedbot:<org>:workflow:<id>:bot:<id>`). Un delta n'est donc valable
 * que si la fenêtre lue ne couvre QUE cette étape. On le prouve par l'invariant
 * mesuré sur le 211 : l'entrée brute d'un appel vaut l'entrée fraîche plus
 * l'entrée relue du cache : dès que `frais + cache` DÉPASSE l'entrée brute du
 * run, un autre run a écrit dans la même session entre les deux lectures et le
 * brut reprend la main. Un écart dans l'autre sens (compteurs en retard,
 * gateway qui ventile autrement) ne peut pas sur-escompter puisque la remise
 * reste bornée par l'entrée du run : on l'applique.
 *
 * Toute incertitude retombe sur le brut. On préfère SURFACTURER : un budget qui
 * déborde reste un budget, un budget qui ne borne plus rien laisse un workflow
 * courir sans plafond.
 */
function workflowTokenAccounting(input: {
  usage: unknown;
  before: HermesSessionCounters | null;
  after: HermesSessionCounters | null;
  cachedWeight: number;
}): WorkflowTokenAccounting {
  const rawTokens = usageTotal(input.usage);
  const base = { effectiveTokens: rawTokens, rawTokens, cachedTokens: 0 } as const;
  if (rawTokens <= 0) return { ...base, reason: "no_cache" };
  if (!input.before || !input.after) return { ...base, reason: "counters_unavailable" };

  const cached = input.after.cacheReadTokens - input.before.cacheReadTokens;
  const fresh = input.after.inputTokens - input.before.inputTokens;
  // Une session réinitialisée (ou recréée sous le même id) fait reculer un
  // compteur cumulatif : le delta ne veut plus rien dire.
  if (cached < 0 || fresh < 0) return { ...base, reason: "counters_reset" };
  if (cached === 0) return { ...base, reason: "no_cache" };
  if (cached + fresh > usageInput(input.usage)) return { ...base, reason: "counters_out_of_window" };

  const weight = Math.min(1, Math.max(0, input.cachedWeight));
  const discount = Math.round(cached * (1 - weight));
  return {
    effectiveTokens: Math.max(0, rawTokens - discount),
    rawTokens,
    cachedTokens: cached,
    reason: "cache_discounted",
  };
}

/**
 * Lecture best-effort des compteurs. Une comptabilité indisponible n'est
 * jamais une raison de faire échouer une étape : on trace et on retombe sur le
 * brut.
 */
export async function readWorkflowSessionCounters(
  context: Pick<RunContext, "id" | "organizationId" | "sessionId" | "workflowId">,
  client: Pick<HermesClient, "sessionCounters">,
  signal?: AbortSignal,
): Promise<HermesSessionCounters | null> {
  // DM ordinaire : pas de workflow, pas de budget, pas d'appel.
  if (!context.workflowId) return null;
  try {
    return await client.sessionCounters(context.sessionId, signal);
  } catch (error) {
    log("worker.session_counters_unavailable", {
      runId: context.id,
      organizationId: context.organizationId,
      workflowId: context.workflowId,
      error: describe(error),
    });
    return null;
  }
}

/** Les compteurs de session peuvent être écrits juste APRÈS `run.completed`. */
const SESSION_COUNTERS_SETTLE_MS = 200;

/**
 * Mesure le coût effectif d'une étape terminée. Hors transaction : cette
 * lecture est un appel réseau et ne doit tenir aucun verrou PostgreSQL.
 */
export async function measureWorkflowTokens(
  config: WorkerConfig,
  context: RunContext,
  usage: unknown,
  client: HermesClient | undefined,
): Promise<WorkflowTokenAccounting> {
  const before = context.sessionCountersBefore ?? null;
  // Reprise d'un run déjà créé, ou client absent : sans point de départ le
  // delta n'existe pas et le brut reste la seule valeur défendable.
  let after: HermesSessionCounters | null = null;
  if (client && before) {
    after = await readWorkflowSessionCounters(context, client);
    // Compteurs strictement inchangés alors que le run a bien consommé : la
    // gateway n'a pas encore écrit l'usage de l'appel. Une seule reprise, bornée.
    if (
      after &&
      after.cacheReadTokens === before.cacheReadTokens &&
      after.inputTokens === before.inputTokens &&
      usageTotal(usage) > 0
    ) {
      await new Promise((resolve) => setTimeout(resolve, SESSION_COUNTERS_SETTLE_MS));
      after = await readWorkflowSessionCounters(context, client);
    }
  }
  const accounting = workflowTokenAccounting({
    usage, before, after, cachedWeight: config.cachedInputTokenWeight,
  });
  log("worker.workflow_tokens", {
    runId: context.id,
    organizationId: context.organizationId,
    workflowId: context.workflowId,
    rawTokens: accounting.rawTokens,
    effectiveTokens: accounting.effectiveTokens,
    cachedTokens: accounting.cachedTokens,
    reason: accounting.reason,
  });
  return accounting;
}
