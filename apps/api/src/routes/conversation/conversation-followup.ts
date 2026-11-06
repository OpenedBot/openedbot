import type { SQL } from "bun";
import {
  type BotIdentity,
} from "@openedbot/roster/domain/bot-mode";
import { appendRunEventsTx } from "@openedbot/execution/sql/run-events";
import { SERVICE_STEP_KINDS } from "@openedbot/execution/domain/run-step";
import type { MessageContent } from "@openedbot/contracts-api";
import { logEvent } from "@openedbot/platform-observability";
import { RunTrace, runLatencyVerdicts } from "@openedbot/platform-observability/run-trace";
import {
  type CancellationRun,
} from "@openedbot/execution/application/run-cancellation";

/** Le contrat public Hermes borne le texte d'un steer à 64 Kio de caractères. */
export const MAX_RUN_STEER_CHARS = 65_536;

// ── Bot mode (hand-off `@mention`) ───────────────────────────────────────────
//
// Un « courrier » (run `handoff_target_bot_id`, statut 'relaying') occupe le
// fil d'ORIGINE sans jamais appeler Hermes ; le run « entrant »
// (`origin_run_id`) vit dans le fil DM de la CIBLE et s'exécute comme un run
// ordinaire. La livraison de la réponse est faite par le worker ; l'API ne
// livre que l'issue « annulé » (elle seule sait annuler un run).

/**
 * Trouve la seule cible à laquelle un follow-up peut être injecté sans casser
 * le routage. Un tour réclamé (`starting` avec bail) ou déjà `running` /
 * `awaiting_approval` compte, même avant le premier octet Hermes : le steer
 * reste `pending` jusqu'au stream. Le verrou key-share fige l'éligibilité
 * jusqu'au commit du repli.
 */
export async function activeRunSteerTargetTx(
  tx: Bun.TransactionSQL,
  input: {
    organizationId: string;
    threadId: string;
    botId: string;
    groupId: string | null;
    input: string;
    attachmentCount: number;
    replyToId: string | null;
    handoff: boolean;
  },
): Promise<string | null> {
  if (
    input.groupId || input.attachmentCount > 0 || input.replyToId || input.handoff ||
    input.input.length === 0 || input.input.length > MAX_RUN_STEER_CHARS
  ) return null;
  // Un run de service (passe mémoire, brouillon de persona, compaction)
  // partage le fil et le bot du DM mais n'est pas une conversation : un
  // follow-up qui y serait injecté rejoindrait une session d'extraction sans
  // bulle, et le run de repli de l'opérateur serait annulé sans réponse
  // (observé le 07-09 : question posée 15 s après « retiens que… », avalée
  // par la passe mémoire).
  const rows = await tx<Array<{ id: string }>>`
    select run.id from runs run
     where run.organization_id = ${input.organizationId}
       and run.thread_id = ${input.threadId}
       and run.bot_id = ${input.botId}
       and run.status in ('starting', 'running', 'awaiting_approval')
       and run.origin is distinct from 'bot_greeting'
       and (run.lease_owner is not null or run.status = 'running')
       and (run.step_kind is null or run.step_kind not in ${tx([...SERVICE_STEP_KINDS])})
       and run.remote_stop_state is null
     order by run.started_at asc nulls last, run.created_at asc, run.id asc
     limit 1 for key share
  `;
  return rows[0]?.id ?? null;
}

/**
 * Moitié API du traceur De la réception du POST au commit, en
 * noms et durées seulement. Le worker reprend à la réclamation, relié par
 * `runId` et par `queuedMs` (horloge PostgreSQL).
 */
export function logRunAdmission(runId: string, organizationId: string, trace: RunTrace): void {
  const summary = trace.summary();
  logEvent("run.admission", {
    runId,
    organizationId,
    ...summary,
    verdicts: runLatencyVerdicts({ admission: summary.marks["api.committed"] ?? null }),
  });
}

export type FollowupDisposition =
  | { kind: "fold"; runId: string; workflowId: string | null; autonomyEnabled: boolean }
  | { kind: "enqueue"; runId: string; workflowId: string | null; autonomyEnabled: boolean; attemptId: string; targetRunId: string }
  | { kind: "supersede"; runId: string; texts: string[]; steerTexts: string[] }
  | { kind: "steer"; runId: string }
  | { kind: "fifo" };

/**
 * Ce qu'un message DM texte devient quand le bot travaille déjà : la politique
 * « supersede + prepend » de Grok Bot, voir `@openedbot/conversation/domain/followup`.
 *
 * L'ordre est celui de la préférence : replier dans un run encore en file (rien
 * n'est calculé, rien n'est perdu) ; sinon remplacer un run qui n'a encore rien
 * montré (le raisonnement en cours est perdu, comme chez Grok Bot, mais
 * l'opérateur obtient UNE réponse) ; sinon steerer un run qui a déjà montré du
 * travail (le modèle intègre à la frontière d'outil suivante) ; sinon la file
 * FIFO ordinaire. Les mêmes conditions d'admissibilité que le steer : DM, texte
 * seul, sans citation, sans pièce jointe, sans handoff, sous 64 Kio.
 *
 * Les requêtes verrouillent le run choisi : un `update runs` du worker (bail,
 * réclamation) attend derrière, et la réclamation en `skip locked` passe son
 * chemin. Les alias `queued` et `active` sont volontaires : les tests de route
 * stubbent `select run.id from runs run` pour la cible de steering.
 */
export async function followupDispositionTx(
  tx: Bun.TransactionSQL,
  input: {
    organizationId: string;
    threadId: string;
    botId: string;
    groupId: string | null;
    initiatorUserId: string;
    input: string;
    attachmentCount: number;
    replyToId: string | null;
    handoff: boolean;
    /** A plan-only turn never shares a run: it is always a run of its own. */
    planOnly?: boolean;
  },
): Promise<FollowupDisposition> {
  const plainText = input.attachmentCount === 0 && !input.replyToId && !input.handoff && !input.planOnly
    && input.input.length > 0 && input.input.length <= MAX_RUN_STEER_CHARS;
  if (input.groupId) {
    if (!plainText) return { kind: "fifo" };
    // Un salon ne se steere pas. Le second message rejoint le seul run de
    // salon encore en file : pas un workflow de plus par frappe.
    const queuedGroup = await tx<Array<{ id: string; workflowId: string | null; workflowAutonomyEnabled: boolean | null }>>`
      select queued.id, queued.workflow_id as "workflowId",
             workflow.autonomy_enabled as "workflowAutonomyEnabled"
        from runs queued
        join workflows workflow
          on workflow.organization_id = queued.organization_id and workflow.id = queued.workflow_id
       where queued.organization_id = ${input.organizationId}
         and queued.thread_id = ${input.threadId}
         and queued.status = 'queued' and queued.external_state = 'not_started'
         and queued.hermes_run_id is null and queued.lease_owner is null
         and queued.step_kind = 'group'
         and workflow.kind = 'group' and workflow.status = 'queued'
         and workflow.initiator_user_id = ${input.initiatorUserId}
         -- Nor does an ordinary message join a plan-only turn: it would run
         -- under plan, or merge the plan request into an executing turn.
         and not queued.plan_only and not workflow.plan_only
       order by queued.created_at desc, queued.id desc
       limit 1 for update of queued
    `;
    if (queuedGroup[0]) {
      return {
        kind: "fold",
        runId: queuedGroup[0].id,
        workflowId: queuedGroup[0].workflowId,
        autonomyEnabled: queuedGroup[0].workflowAutonomyEnabled === true,
      };
    }
    return { kind: "fifo" };
  }
  if (!plainText) return { kind: "fifo" };
  // Un run replié doit être un tour d'opérateur, texte seul, sans steer en
  // vol (sa tentative porterait un texte incomplet) et jamais réclamé. Un DM
  // simple n'a pas de workflow : son run porte lui-même l'initiateur.
  const queued = await tx<Array<{ id: string; workflowId: string | null; workflowAutonomyEnabled: boolean | null }>>`
    select queued.id, queued.workflow_id as "workflowId",
           workflow.autonomy_enabled as "workflowAutonomyEnabled"
      from runs queued
      left join workflows workflow
        on workflow.organization_id = queued.organization_id and workflow.id = queued.workflow_id
     where queued.organization_id = ${input.organizationId}
       and queued.thread_id = ${input.threadId}
       and queued.bot_id = ${input.botId}
       and queued.status = 'queued' and queued.external_state = 'not_started'
       and queued.origin is distinct from 'bot_greeting'
       and queued.hermes_run_id is null and queued.lease_owner is null and queued.remote_stop_state is null
       and queued.step_kind = 'root' and queued.caller_bot_id is null and queued.origin_run_id is null
       and not queued.plan_only and not coalesce(workflow.plan_only, false)
       and (
         (queued.workflow_id is null and queued.initiator_user_id = ${input.initiatorUserId})
         or (workflow.status = 'queued' and workflow.kind = 'dm'
             and workflow.initiator_user_id = ${input.initiatorUserId})
       )
       and not exists (
         select 1 from run_steering_attempts steer
          where steer.organization_id = queued.organization_id and steer.source_run_id = queued.id
            and steer.status in ('pending', 'sending')
       )
       and not exists (
         select 1 from messages message
           left join attachments attachment
             on attachment.organization_id = message.organization_id and attachment.message_id = message.id
          where message.organization_id = queued.organization_id and message.run_id = queued.id
            and (attachment.id is not null or message.reply_to_id is not null)
       )
     order by queued.created_at desc, queued.id desc
     limit 1 for update of queued
  `;
  if (queued[0]) {
    return {
      kind: "fold",
      runId: queued[0].id,
      workflowId: queued[0].workflowId,
      autonomyEnabled: queued[0].workflowAutonomyEnabled === true,
    };
  }
  // Rafale pendant qu'un steer est déjà en file : on allonge CETTE tentative,
  // on n'ouvre ni run ni workflow de plus.
  const pending = await tx<Array<{
    id: string;
    workflowId: string | null;
    workflowAutonomyEnabled: boolean | null;
    attemptId: string;
    targetRunId: string;
  }>>`
    select followup.id, followup.workflow_id as "workflowId",
           workflow.autonomy_enabled as "workflowAutonomyEnabled",
           steer.id as "attemptId", target.id as "targetRunId"
      from runs followup
      join run_steering_attempts steer
        on steer.organization_id = followup.organization_id and steer.source_run_id = followup.id
      join runs target
        on target.organization_id = steer.organization_id and target.id = steer.target_run_id
      left join workflows workflow
        on workflow.organization_id = followup.organization_id and workflow.id = followup.workflow_id
     where followup.organization_id = ${input.organizationId}
       and followup.thread_id = ${input.threadId}
       and followup.bot_id = ${input.botId}
       and followup.status = 'queued' and followup.lease_owner is null
       and followup.hermes_run_id is null
       and steer.status = 'pending'
       and target.bot_id = ${input.botId}
       and target.status in ('starting', 'running', 'awaiting_approval')
       and target.origin is distinct from 'bot_greeting'
       and target.remote_stop_state is null
       and not target.plan_only
       and not exists (
         select 1 from workflows target_workflow
          where target_workflow.organization_id = target.organization_id
            and target_workflow.id = target.workflow_id and target_workflow.plan_only
       )
       and char_length(steer.text) + char_length(${input.input}) + 2 <= 65536
     order by steer.created_at asc, steer.id asc
     limit 1 for update of followup, steer
  `;
  if (pending[0]) {
    return {
      kind: "enqueue",
      runId: pending[0].id,
      workflowId: pending[0].workflowId,
      autonomyEnabled: pending[0].workflowAutonomyEnabled === true,
      attemptId: pending[0].attemptId,
      targetRunId: pending[0].targetRunId,
    };
  }
  // Un run « silencieux » : il stream, mais rien n'a encore été montré ni
  // engagé. Un texte déjà écrit, un outil appelé ou une approbation demandée
  // sont des effets qu'on ne jette pas : ce run-là se steere.
  const quiet = await tx<Array<{ id: string }>>`
    select active.id from runs active
     where active.organization_id = ${input.organizationId}
       and active.thread_id = ${input.threadId}
       and active.bot_id = ${input.botId}
       and active.status = 'running' and active.external_state = 'streaming'
       and active.origin is distinct from 'bot_greeting'
       and active.hermes_run_id is not null and active.remote_stop_state is null
       and active.step_kind = 'root' and active.caller_bot_id is null and active.origin_run_id is null
       and not active.plan_only
       and not exists (
         select 1 from workflows active_workflow
          where active_workflow.organization_id = active.organization_id
            and active_workflow.id = active.workflow_id and active_workflow.plan_only
       )
       and not exists (
         select 1 from run_events event
          where event.organization_id = active.organization_id and event.run_id = active.id
            and event.type in ('agent.message', 'tool.call', 'approval.requested')
       )
       and not exists (
         select 1 from run_steering_attempts steer
          where steer.organization_id = active.organization_id and steer.target_run_id = active.id
            and steer.status in ('pending', 'sending', 'ambiguous')
       )
       and not exists (
         select 1 from messages message
           left join attachments attachment
             on attachment.organization_id = message.organization_id and attachment.message_id = message.id
          where message.organization_id = active.organization_id and message.run_id = active.id
            and (attachment.id is not null or message.reply_to_id is not null)
       )
     order by active.started_at asc nulls last, active.created_at asc, active.id asc
     limit 1 for update of active
  `;
  if (quiet[0]) {
    const steers = await tx<Array<{ text: string }>>`
      select text from run_steering_attempts
       where organization_id = ${input.organizationId} and target_run_id = ${quiet[0].id}
         and status = 'confirmed' and error_code is null
       order by created_at asc, id asc
    `;
    return {
      kind: "supersede",
      runId: quiet[0].id,
      texts: await runUserTextsTx(tx, input.organizationId, quiet[0].id),
      steerTexts: steers.map((row) => row.text),
    };
  }
  const target = await activeRunSteerTargetTx(tx, input);
  return target ? { kind: "steer", runId: target } : { kind: "fifo" };
}

/**
 * Les textes des messages opérateur d'un run, dans l'ordre. C'est cela qu'on
 * fusionne, jamais `runs.input` : l'entrée exécutée porte déjà la ligne
 * `[Workflow limits]` que le worker pose à chaque tour, et la répéter la
 * ferait lire deux fois au modèle.
 */
async function runUserTextsTx(tx: Bun.TransactionSQL, organizationId: string, runId: string): Promise<string[]> {
  const rows = await tx<Array<{ content: MessageContent | null }>>`
    select content from messages
     where organization_id = ${organizationId} and run_id = ${runId} and role = 'user'
     order by sequence asc, created_at asc
  `;
  return rows.map((row) => (Array.isArray(row.content) ? row.content : [])
    .map((part) => (part && typeof part === "object" && "type" in part && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n"));
}

/** Le texte déposé dans le fil d'origine quand le run entrant est annulé (cf. replyTextFor, côté worker). */
export function cancelledHandoffReply(target: { name: string | null; slug: string | null }): string {
  return `La mission de 🤖 ${target.name ?? "bot supprimé"} (@${target.slug ?? "?"}) a été annulée.`;
}

/** Les autres bots joignables de l'organisation, chacun avec son fil DM. */
export async function handoffRosterTx(
  tx: Bun.TransactionSQL,
  organizationId: string,
  selfBotId: string,
): Promise<BotIdentity[]> {
  return tx<BotIdentity[]>`
    select b.id, b.name, b.slug, b.description, t.id as "threadId"
      from bots b
      join threads t on t.organization_id = b.organization_id and t.bot_id = b.id
        and t.is_default
     where b.organization_id = ${organizationId} and b.archived_at is null and b.id <> ${selfBotId}
  `;
}

/**
 * Livre l'issue « annulé » aux courriers dont le run entrant vient d'être
 * annulé : message attribué à la cible dans le fil d'origine, courrier
 * complété, événements `bot.message` + `run.completed` : la même séquence que
 * la livraison du worker. Un courrier déjà terminal (annulé par l'opérateur)
 * ne reçoit plus rien. Les clients connectés reçoivent ces événements par le
 * rejeu SSE (event-routes), comme tout événement écrit en base.
 */
export async function settleCancelledHandoffsTx(
  tx: Bun.TransactionSQL,
  organizationId: string,
  cancelled: readonly CancellationRun[],
): Promise<void> {
  for (const run of cancelled) {
    if (!run.originRunId) continue;
    const origins = await tx<Array<{ id: string; threadId: string; status: string }>>`
      select id, thread_id as "threadId", status from runs
       where organization_id = ${organizationId} and id = ${run.originRunId}
    `;
    const origin = origins[0];
    if (!origin || origin.status !== "relaying") continue;
    // La cible est relue même archivée : elle reste nommée dans la réponse.
    const targets = await tx<Array<{ name: string; slug: string }>>`
      select name, slug from bots where organization_id = ${organizationId} and id = ${run.botId}
    `;
    const target = targets[0] ?? { name: null, slug: null };
    const text = cancelledHandoffReply(target);
    const messageId = crypto.randomUUID();
    await tx`
      insert into messages (id, organization_id, thread_id, run_id, role, content, author_bot_id)
      values (${messageId}, ${organizationId}, ${origin.threadId}, ${origin.id},
              -- role 'user' : entrée du fil d'origine, rendue BotInboundMessage côté client.
              'user', ${[{ type: "text", text }]}, ${run.botId})
    `;
    // Le statut AVANT les événements : un client qui reçoit `run.completed`
    // et relit le fil doit y trouver un courrier déjà terminé.
    await tx`
      update runs set status = 'completed', ended_at = now(), updated_at = now()
       where organization_id = ${organizationId} and id = ${origin.id}
    `;
    // The update above holds the courier's row: the primitive takes the cursor after it.
    const occurredAt = new Date();
    await appendRunEventsTx(tx as unknown as SQL, [
      {
        organizationId, threadId: origin.threadId, runId: origin.id, occurredAt,
        type: "bot.message",
        payload: {
          messageId,
          fromBotId: run.botId,
          fromSlug: target.slug,
          fromName: target.name,
          text,
          ok: false,
        },
      },
      {
        organizationId, threadId: origin.threadId, runId: origin.id, occurredAt,
        type: "run.completed", payload: { output: null, usage: null },
      },
    ]);
    await tx`
      update threads set updated_at = now()
       where organization_id = ${organizationId} and id = ${origin.threadId}
    `;
  }
}
