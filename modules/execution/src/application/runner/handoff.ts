import type { SQL } from "bun";
import {
  HANDOFF_NOTICE_KIND,
  attributedInput,
  handoffSentNotice,
  type BotIdentity,
  type HandoffMention,
} from "@openedbot/roster/domain/bot-mode";
import { UNTRACKED_BACKGROUND_TOOLS } from "@openedbot/runtimes/domain/runtime-contract";
import { organizationEventEnvelope, type OrganizationEvent } from "@openedbot/contracts-events";
import { insertHandoffInboundMessage, insertHandoffReplyMessage } from "@openedbot/conversation/sql/messages";
import { touchThread } from "@openedbot/conversation/sql/threads";
import { appendNoticeTx, lockRunEventCursorTx } from "./events";
import type { HandoffChildContext, RunContext, RunEventIdentityRow } from "./types";
import { log } from "./util";

// ── Bot mode (hand-off `@mention`) ───────────────────────────────────────────
//
// Un « courrier » (run `handoff_target_bot_id`, statut 'relaying') vit dans le
// fil d'ORIGINE : il occupe ce fil le temps que le bot cible réponde, sans
// jamais appeler Hermes : la file ne réclame que 'queued', le moissonneur de
// baux ne fauche que 'starting'/'running'. Le run « entrant »
// (`origin_run_id = courrier`) vit dans le fil DM de la CIBLE : un run Hermes
// ordinaire dont l'entrée est attribuée (`Message from 🤖 …`). Quand il se
// termine : bien ou mal : sa réponse est déposée dans le fil d'origine,
// attribuée à la cible, et le courrier se ferme. L'issue « annulé » est
// livrée par l'API (elle seule annule) : voir settleCancelledHandoffsTx.

export { HANDOFF_NOTICE_KIND };

/**
 * Outils runtime « fire-and-forget ». La liste vit dans le cœur
 * (`runtime-contract.ts`) depuis le 2026-08-26 : le panneau Capacités signale
 * le toolset qui les fournit AVANT qu'un run les appelle, le worker détecte
 * l'appel APRÈS, et deux listes séparées auraient fini par diverger.
 */
const FIRE_AND_FORGET_TOOLS = UNTRACKED_BACKGROUND_TOOLS;

/** Vrai si l'un des outils appelés pendant le run est une délégation non suivie. */
export function detectFireAndForget(tools: ReadonlyArray<unknown>): boolean {
  return tools.some((tool) => typeof tool === "string" && FIRE_AND_FORGET_TOOLS.has(tool.trim().toLowerCase()));
}

/**
 * L'avertissement fire-and-forget appartient-il au fil de CE run ?
 *
 * Oui pour tout run qui a un bot : DM, tour de salon, étape de workflow. Non
 * pour un run ENTRANT (`originRunId`) : son avertissement appartient au fil
 * d'ORIGINE, où `deliverHandoffReplyTx` le dépose déjà ; le poser ici aussi le
 * ferait lire deux fois, dans deux conversations.
 *
 * Le garde était `handoffEligible`, qui répond à une autre question : « ce run
 * peut-il ouvrir un hand-off ? ». Il excluait donc les tours de salon et les
 * étapes de workflow, et un bot qui déléguait hors plateforme depuis un salon
 * ne laissait aucune trace (corrigé le 2026-08-26).
 */
export function untrackedToolNoticeBelongsHere(run: {
  originRunId: string | null;
  botId: string | null;
  // Acceptés et IGNORÉS : les passer explicitement est ce qui rend le test
  // lisible face à `handoffEligible`, qui lui s'en sert.
  groupId?: string | null;
  groupTurnPosition?: number | null;
}): boolean {
  return run.originRunId === null && run.botId !== null;
}

/** L'avertissement déposé dans le fil d'origine quand la cible a délégué hors plateforme. */
export function delegatedHandoffNotice(target: { name: string; slug: string }): string {
  return `⚠ 🤖 ${target.name} (@${target.slug}) a délégué le travail à une tâche externe non suivie par la plateforme : aucune suite n’arrivera dans ce fil. Relancez-le pour obtenir le résultat.`;
}

/**
 * Seul un run DM ordinaire parle le protocole bot et peut ouvrir un hand-off :
 * jamais un tour de salon, jamais un run entrant (`origin_run_id`) : la
 * profondeur est de 1, un bot relayé ne relaie pas à son tour.
 */
export function handoffEligible(run: {
  groupId: string | null;
  groupTurnPosition: number | null;
  originRunId: string | null;
}): boolean {
  return !run.groupId && run.groupTurnPosition === null && !run.originRunId;
}

/**
 * Tour de DM simple : un tour racine d'opérateur que l'API a admis
 * sans workflow, faute d'état durable (ni salon, ni hand-off, ni autonomie).
 * Les runs historiques sans `step_kind` gardent leur ancien chemin.
 */
export function simpleDmStep(run: {
  workflowId?: string | null;
  stepKind?: RunContext["stepKind"];
  groupId: string | null;
  groupTurnPosition: number | null;
  originRunId: string | null;
}): boolean {
  return !run.workflowId && run.stepKind === "root" && handoffEligible(run);
}

/**
 * Ce que le fil d'origine lira, selon l'issue du run entrant. Libellés publics
 * stables uniquement : une sortie vide est un ÉCHEC (rien d'utile n'a été
 * livré), et l'erreur Hermes brute n'est jamais relayée dans le fil (fuite
 * d'internals) : le détail reste dans les logs worker (voir deliverHandoffReplyTx).
 */
export function replyTextFor(
  child: { status: string; output: string | null; error: string | null },
  target: { name: string; slug: string },
): { text: string; ok: boolean } {
  if (child.status === "completed") {
    const text = child.output?.trim() ?? "";
    if (text) return { text, ok: true };
    return { text: `🤖 ${target.name} (@${target.slug}) a terminé sans produire de réponse.`, ok: false };
  }
  if (child.status === "cancelled") {
    return { text: `La mission de 🤖 ${target.name} (@${target.slug}) a été annulée.`, ok: false };
  }
  return { text: `🤖 ${target.name} (@${target.slug}) n’a pas pu répondre.`, ok: false };
}

/** Les autres bots joignables de l'organisation, chacun avec son fil DM. */
export async function handoffRoster(db: SQL, organizationId: string, selfBotId: string): Promise<BotIdentity[]> {
  return db<BotIdentity[]>`
    select b.id, b.name, b.slug, b.description, t.id as "threadId"
     from bots b
      join threads t on t.organization_id = b.organization_id and t.bot_id = b.id
        and t.is_default
     where b.organization_id = ${organizationId} and b.archived_at is null and b.id <> ${selfBotId}
     order by b.id
     for key share of b
  `;
}

/**
 * Crée la paire courrier + run entrant dans la transaction du run qui vient de
 * se terminer : le fil d'origine, tout juste libéré, est repris par le
 * courrier avant tout autre. `created: false` si le fil de la cible est
 * occupé : le run entrant attend désormais dans la file durable du fil cible.
 * `notice` est l'événement « Transmis à … » du courrier, à publier par
 * l'appelant.
 */
export async function createHandoffTx(
  tx: SQL,
  context: RunContext,
  mention: HandoffMention,
): Promise<{ created: boolean; notice: OrganizationEvent | null }> {
  const courierId = crypto.randomUUID();
  const inboundId = crypto.randomUUID();
  await tx`
    insert into runs (id, organization_id, thread_id, bot_id, input, status, origin_run_id)
    values (${inboundId}, ${context.organizationId}, ${mention.threadId}, ${mention.botId},
            ${attributedInput({ name: context.botName, slug: context.botSlug }, mention.message)},
            'queued', ${courierId})
  `;
  // Le courrier n'a pas de `bot_id` (voir RunDto) ni de ligne message : la
  // sortie du bot d'origine, avec sa mention, est déjà le dernier message.
  await tx`
    insert into runs (id, organization_id, thread_id, bot_id, input, status, handoff_target_bot_id)
    values (${courierId}, ${context.organizationId}, ${context.threadId}, null,
            ${mention.message}, 'relaying', ${mention.botId})
  `;
  await insertHandoffInboundMessage(tx, {
    organizationId: context.organizationId,
    threadId: mention.threadId,
    runId: inboundId,
    text: mention.message,
    authorBotId: context.botId,
  });
  await touchThread(tx, context.organizationId, mention.threadId);
  // « Transmis à … » sur le COURRIER : le fil d'origine voit tout de suite que
  // la main est passée, avant même la réponse de la cible.
  const notice = await appendNoticeTx(
    tx,
    { organizationId: context.organizationId, threadId: context.threadId, id: courierId },
    { message: handoffSentNotice(mention), kind: HANDOFF_NOTICE_KIND.sent, targetBotId: mention.botId },
  );
  return { created: true, notice };
}

/**
 * Livre l'issue d'un run entrant à son courrier, s'il attend toujours : message
 * attribué à la cible dans le fil d'origine, courrier complété, événements
 * `bot.message` + `run.completed`. Un courrier annulé par l'opérateur ne
 * reçoit plus rien : il a dit stop. Retourne les enveloppes à publier.
 */
export async function deliverHandoffReplyTx(
  tx: SQL,
  context: HandoffChildContext,
  child: { status: "completed" | "failed" | "cancelled"; output: string | null; error: string | null },
): Promise<OrganizationEvent[]> {
  if (!context.originRunId) return [];
  const origins = await tx<Array<{ id: string; threadId: string; status: string }>>`
    select id, thread_id as "threadId", status from runs
     where organization_id = ${context.organizationId} and id = ${context.originRunId}
     for update
  `;
  const origin = origins[0];
  if (!origin) {
    log("worker.handoff_origin_missing", { runId: context.id, originRunId: context.originRunId });
    return [];
  }
  if (origin.status !== "relaying") return [];
  const reply = replyTextFor(child, { name: context.botName, slug: context.botSlug });
  if (child.status === "failed") {
    // Le fil ne reçoit qu'un libellé public (voir replyTextFor) : le détail de
    // l'erreur Hermes reste ici, dans les logs worker.
    log("worker.handoff_child_failed", {
      runId: context.id,
      originRunId: context.originRunId,
      error: child.error?.trim() || "erreur inconnue",
    });
  }
  // Les events du run entrant sont déjà persistés (transactions précédentes de
  // persistEvents) : une requête suffit à savoir si la cible a délégué le
  // travail à un outil fire-and-forget dont personne ne suivra le résultat.
  const toolRows = await tx<Array<{ tool: string | null }>>`
    select distinct payload->>'tool' as tool from run_events
     where organization_id = ${context.organizationId} and run_id = ${context.id} and type = 'tool.call'
  `;
  const delegated = detectFireAndForget(toolRows.map((row) => row.tool));
  const messageId = crypto.randomUUID();
  await insertHandoffReplyMessage(tx, {
    messageId,
    organizationId: context.organizationId,
    threadId: origin.threadId,
    runId: origin.id,
    text: reply.text,
    authorBotId: context.botId,
  });
  // Le statut AVANT les événements : un client qui reçoit `run.completed`
  // et relit le fil doit y trouver un courrier déjà terminé.
  await tx`
    update runs set status = 'completed', ended_at = now(), updated_at = now()
     where organization_id = ${context.organizationId} and id = ${origin.id} and status = 'relaying'
  `;
  await lockRunEventCursorTx(tx, context.organizationId);
  const sequenceRows = await tx<Array<{ next: number }>>`
    select coalesce(max(sequence), -1) + 1 as next from run_events
     where organization_id = ${context.organizationId} and run_id = ${origin.id}
  `;
  const first = Number(sequenceRows[0]?.next ?? 0);
  const occurredAt = new Date();
  const events: Array<{ sequence: number; type: string; payload: Record<string, unknown> }> = [
    {
      sequence: first,
      type: "bot.message",
      payload: {
        messageId,
        fromBotId: context.botId,
        fromSlug: context.botSlug,
        fromName: context.botName,
        text: reply.text,
        ok: reply.ok,
      },
    },
    // Avertissement seulement, jamais un blocage : la délégation perdue est
    // signalée après la réponse, avant la clôture du courrier.
    ...(delegated
      ? [{
          sequence: first + 1,
          type: "system.notice",
          payload: {
            message: delegatedHandoffNotice({ name: context.botName, slug: context.botSlug }),
            kind: HANDOFF_NOTICE_KIND.delegated,
            botId: context.botId,
          } as Record<string, unknown>,
        }]
      : []),
    { sequence: first + (delegated ? 2 : 1), type: "run.completed", payload: { output: null, usage: null } },
  ];
  const result: OrganizationEvent[] = [];
  for (const event of events) {
    const rows = await tx<RunEventIdentityRow[]>`
      insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at)
      values (${context.organizationId}, ${origin.threadId}, ${origin.id}, ${event.sequence},
              ${event.type}, ${event.payload}, ${occurredAt})
      on conflict (organization_id, run_id, sequence) do nothing
      returning cursor, bot_id as "botId", turn_id as "turnId", session_key as "sessionKey",
                lease_generation as "leaseGeneration"
    `;
    const row = rows[0];
    if (!row) continue;
    result.push(organizationEventEnvelope({
      ...row, organizationId: context.organizationId, threadId: origin.threadId,
      runId: origin.id, sequence: event.sequence, type: event.type, payload: event.payload, occurredAt,
    }));
  }
  await touchThread(tx, context.organizationId, origin.threadId);
  return result;
}
