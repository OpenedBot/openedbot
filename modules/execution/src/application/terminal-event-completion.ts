import type { OrganizationEvent } from "@openedbot/contracts-events";
import {
  isTerminalProductEvent,
  TERMINAL_COMPLETION_VERSION,
  type TerminalCompletion,
} from "@openedbot/conversation/domain/thread-snapshot-mutations";
import type { ProductEventType } from "@openedbot/contracts-events";
import { messageDto, publicRunStatus, type MessageRow } from "@openedbot/conversation/domain/message-dto";
import type { TransactionDb } from "@openedbot/platform-db";

/**
 * Ce que l'événement terminal d'un run emporte avec lui : la réponse
 * PERSISTÉE, la ligne du run conclue, et le workflow dont il était une étape.
 *
 * ## Le défaut corrigé
 *
 * Le message final d'une génération ne vit pas dans le flux : le worker
 * l'écrit dans `messages` au moment même où il écrit `run.completed`
 * (`modules/execution/src/application/runner/persist.ts`, une seule transaction). Les deux clients en
 * tiraient la même conclusion (« je ne l'ai pas, je relis tout le fil ») et
 * une fin de génération coûtait donc un `GET /api/threads/:id` complet
 * (jusqu'à 1 000 messages et 5 000 événements) juste pour récupérer une bulle.
 * Sur un client natif, cette lecture passe en plus par le réseau réel puis par un
 * validateur ; la bulle finale ne se stabilise qu'à la fin de tout ça.
 *
 * ## Pourquoi la lecture, et non l'écriture
 *
 * L'enrichissement se fait ICI, au rejeu SSE, et non chez le producteur, pour
 * trois raisons mesurables :
 *
 * 1. Il y a PLUSIEURS producteurs d'événements terminaux : le worker
 *    (`persistEvents`), et le cloud API lui-même pour les courriers de
 *    hand-off annulés (`settleCancelledHandoffsTx`, `conversation-followup.ts`).
 *    Un seul point d'enrichissement, au lieu de trois qui divergeront.
 * 2. Le rejeu SSE est la SEULE source de publication live : le hint HTTP du
 *    worker ne fait que réveiller ce poller (voir `internalEventRoutes`).
 *    Enrichir l'enveloppe du worker n'aurait rien changé pour les clients.
 * 3. `run_events` ne grossit pas d'une copie du texte déjà écrit dans
 *    `messages`, et les runs terminés AVANT ce lot profitent du patch dès
 *    leur prochain rejeu.
 *
 * ## Ce que le bloc ne porte pas
 *
 * Les `reactions` : le poller est partagé par toutes les connexions d'une
 * ORGANISATION, et `reactedByMe` dépend de l'utilisateur qui lit. Un agrégat
 * calculé pour l'un serait faux pour l'autre. Les deux clients traitent déjà
 * l'absence comme « aucune réaction » (`message.reactions ?? []`), ce qui est
 * exact pour un message qui vient de naître.
 */
export function completionEligible(event: OrganizationEvent): boolean {
  // `OrganizationEvent.type` est une chaîne libre (colonne `run_events.type`) :
  // le cast est la frontière, et le classement reste celui du cœur : un type
  // inconnu n'est simplement jamais terminal.
  return isTerminalProductEvent({
    type: event.type as ProductEventType,
    payload: event.payload ?? {},
  });
}

/**
 * Attache son bloc `completion` à chaque événement terminal de la page.
 *
 * Une seule requête par page et par table, quel que soit le nombre de runs
 * conclus dedans : un salon fait terminer plusieurs tours dans la même
 * fenêtre de 150 ms.
 *
 * Les lignes lues sont forcément committées : le poller ne voit que du
 * committé, et le message final partage la transaction de son événement. Un
 * run dont aucune ligne ne revient (pass de salon, run.error) reçoit quand
 * même son bloc, avec `messages: []` : c'est une information, pas un trou.
 */
export async function attachTerminalCompletions(
  tx: TransactionDb,
  organizationId: string,
  events: OrganizationEvent[],
): Promise<OrganizationEvent[]> {
  const runIds = [...new Set(events.filter(completionEligible).map((event) => event.runId))];
  if (runIds.length === 0) return events;

  const [messageRows, runRows, workflowRows] = await Promise.all([
    tx<Array<MessageRow & { runId: string }>>`
      select m.id, m.role, m.content, m.run_id as "runId",
             coalesce(m.original_author_bot_id, m.author_bot_id) as "authorBotId",
             coalesce(m.original_author_name, b.name) as "authorBotName",
             b.slug as "authorBotSlug", b.face as "authorBotFace",
             m.reply_to_id as "replyToId", reply.role as "replyToRole",
             reply.content as "replyToContent",
             coalesce(reply.original_author_bot_id, reply.author_bot_id) as "replyAuthorBotId",
             coalesce(reply.original_author_name, reply_bot.name) as "replyAuthorBotName",
             reply_bot.slug as "replyAuthorBotSlug", reply_bot.face as "replyAuthorBotFace",
             m.created_at as "createdAt"
        from messages m
        left join bots b on b.organization_id = m.organization_id and b.id = m.author_bot_id
        left join messages reply on reply.organization_id = m.organization_id
          and reply.thread_id = m.thread_id and reply.id = m.reply_to_id
        left join bots reply_bot on reply_bot.organization_id = reply.organization_id
          and reply_bot.id = reply.author_bot_id
       where m.organization_id = ${organizationId} and m.run_id in ${tx(runIds)}
         -- L'invite de l'operateur porte le meme run_id et le client l'a
         -- deja : la renvoyer doublerait la trame pour rien. Ce qui reste,
         -- c'est ce que la PLATEFORME a ecrit : la reponse du bot, et le
         -- courrier entrant d'un hand-off (role user, mais author_bot_id).
         and (m.role = 'assistant' or m.author_bot_id is not null)
       order by m.sequence asc nulls last, m.created_at asc, m.id asc
    `,
    tx<Array<Record<string, unknown>>>`
      select id, status, output, usage, error_message as error,
             ended_at as "endedAt", updated_at as "lastEventAt",
             workflow_id as "workflowId", completion_kind as "completionKind",
             case when status = 'unknown' or external_state = 'ambiguous' then 'needs_review' else null end as "recoveryState"
        from runs
       where organization_id = ${organizationId} and id in ${tx(runIds)}
    `,
    tx<Array<Record<string, unknown>>>`
      select w.id, w.kind, w.status, w.root_run_id as "rootRunId", w.root_bot_id as "rootBotId",
             w.autonomy_enabled as "autonomyEnabled",
             w.notification_sequence as "notificationSequence",
             w.used_steps as "usedSteps", w.max_steps as "maxSteps",
             w.used_handoffs as "usedHandoffs", w.max_handoffs as "maxHandoffs",
             w.used_tokens as "usedTokens", w.token_budget as "tokenBudget",
             w.deadline_at as "deadlineAt", w.error_code as "errorCode", w.error_message as "errorMessage",
             w.final_output as "finalOutput",
             case when w.status = 'unknown' then 'needs_review' else null end as "recoveryState",
             w.created_at as "createdAt", w.updated_at as "updatedAt"
        from workflows w
       where w.organization_id = ${organizationId}
         and w.id in (
           select r.workflow_id from runs r
            where r.organization_id = ${organizationId} and r.id in ${tx(runIds)}
              and r.workflow_id is not null
         )
    `,
  ]);

  const messagesByRun = new Map<string, MessageRow[]>();
  for (const row of messageRows) {
    const bucket = messagesByRun.get(row.runId) ?? [];
    bucket.push(row);
    messagesByRun.set(row.runId, bucket);
  }
  const runById = new Map(runRows.map((row) => [String(row.id), row]));
  const workflowById = new Map(workflowRows.map((row) => [String(row.id), row]));

  return events.map((event) => {
    if (!completionEligible(event)) return event;
    const run = runById.get(event.runId);
    // Le run a disparu (purge, suppression du fil) : mieux vaut ne rien
    // attacher : le client retombe sur son rechargement, qui verra la même
    // disparition et la traitera comme telle.
    if (!run) return event;
    const workflowId = run.workflowId === null || run.workflowId === undefined ? null : String(run.workflowId);
    const workflow = workflowId ? workflowById.get(workflowId) ?? null : null;
    const completion: TerminalCompletion = {
      version: TERMINAL_COMPLETION_VERSION,
      // `messageDto` mot pour mot, comme la lecture du snapshot : une seule
      // projection à maintenir, donc aucune dérive possible entre le fil
      // rechargé et le fil patché.
      messages: (messagesByRun.get(event.runId) ?? []).map((row) => messageDto(row)),
      run: {
        id: event.runId,
        status: publicRunStatus(run.status) as TerminalCompletion["run"]["status"],
        output: run.output === undefined ? null : (run.output as string | null),
        usage: (run.usage ?? null) as TerminalCompletion["run"]["usage"],
        error: run.error === undefined ? null : (run.error as string | null),
        endedAt: isoOrNull(run.endedAt),
        lastEventAt: isoOrNull(run.lastEventAt),
        completionKind: typeof run.completionKind === "string" ? run.completionKind : null,
        recoveryState: run.recoveryState === "needs_review" ? "needs_review" : null,
      },
      workflow: workflow ? (workflowDto(workflow) as TerminalCompletion["workflow"]) : null,
    };
    return { ...event, payload: { ...event.payload, completion } };
  });
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

/** Mêmes conversions que `GET /api/threads/:id` : dates ISO, compteurs numériques. */
function workflowDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    createdAt: isoOrNull(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
    deadlineAt: isoOrNull(row.deadlineAt),
    usedTokens: Number(row.usedTokens ?? 0),
    tokenBudget: Number(row.tokenBudget ?? 0),
    notificationSequence: Number(row.notificationSequence ?? 0),
  };
}
