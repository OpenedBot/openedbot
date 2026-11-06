import { isoInstant } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import { approvalReview } from "@openedbot/conversation/domain/approval-review";
import { organizationEventEnvelope, type RunEventRecord } from "@openedbot/contracts-events";
import { messageDto, publicRunStatus, type MessageRow } from "@openedbot/conversation/domain/message-dto";
import type { AppVariables } from "../identity/auth";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { HttpError } from "../../interfaces/http/http-error";
import { readOrganizationCursor } from "@openedbot/conversation/sql/organization-cursor";
import {
  alwaysOffered,
  approvalGateView,
  approvalKind,
  type AlwaysGateRow,
} from "./approval-always";
import {
  answeredRunIds,
  concludedRunIds,
  parseThreadEventWindow,
  preservedRunIds,
  snapshotCursor,
  windowThreadEvents,
} from "@openedbot/conversation/domain/thread-snapshot-window";
import { dateFields, readThreadGroup } from "./conversation-input";

/** La lecture d’un fil : son instantané (messages, runs, approbations, participants). */
export function conversationThreadRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:threadId", async (context) => {
    const auth = context.get("auth");
    // Lu AVANT toute requête : une valeur invalide doit coûter un 400, pas un
    // aller-retour en base.
    const eventWindow = parseThreadEventWindow(context.req.query("events"));
    const snapshot = await withTenant(db, auth.organizationId, async (tx) => {
      const threads = await tx<Array<{
        id: string; botId: string | null; groupId: string | null; title: string; botName: string | null;
        instructions: string | null; model: string | null; runtimeModel: string | null;
        createdAt: Date | string; updatedAt: Date | string;
      }>>`
        select t.id, t.bot_id as "botId", t.group_id as "groupId", t.title, b.name as "botName",
               b.instructions, b.model, t.created_at as "createdAt", t.updated_at as "updatedAt",
               -- La préférence globale d'openedbot : ce qu'un bot sans modèle propre
               -- utilise, et ce que le composer affiche comme « Modèle global ».
               (select r.selected_model from runtimes r
                 where r.organization_id = t.organization_id and r.is_active and r.revoked_at is null
                 order by r.created_at asc limit 1) as "runtimeModel"
          from threads t left join bots b on b.organization_id = t.organization_id and b.id = t.bot_id
         where t.organization_id = ${auth.organizationId} and t.id = ${context.req.param("threadId")}
           -- Un soft delete conserve le fil pour une restauration depuis les
           -- Archives, mais ne doit pas laisser son ancienne URL le servir.
           and (t.bot_id is null or b.deleted_at is null)
      `;
      const thread = threads[0];
      if (!thread) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
      // Le curseur de l'ORGANISATION, lu EN PREMIER et seul, dans la même
      // transaction (READ COMMITTED : chaque SELECT voit ce qui est commité à
      // SON instant). Le worker prend `pg_advisory_xact_lock` par organisation
      // avant son premier insert et le tient jusqu'au commit
      // (`modules/execution/src/sql/run-events.ts` `lockRunEventsTx`) : l'ordre des curseurs est
      // l'ordre des commits. Tout curseur ≤ un max lu à T1 est donc visible
      // par un SELECT à T2 > T1 : ce max est une borne BASSE sûre pour
      // attacher le flux : ce qui est commité après est rejoué par le serveur
      // et dédupliqué côté client. Le lire en DERNIER faisait l'inverse : un
      // commit pour ce fil entre le SELECT des événements et celui du max
      // donnait un curseur au-dessus d'un événement absent du snapshot :
      // jamais rejoué, `run.completed` perdu sans filet.
      const organizationCursor = await readOrganizationCursor(tx, auth.organizationId);
      const [messages, runs, eventRows, approvals, group, workflows] = await Promise.all([
        tx<MessageRow[]>`
          select m.id, m.role, m.content, m.run_id as "runId",
                 ingress.idempotency_key as "clientSubmissionId",
                 coalesce(m.original_author_bot_id, m.author_bot_id) as "authorBotId",
                 coalesce(m.original_author_name, b.name) as "authorBotName",
                 b.slug as "authorBotSlug", b.face as "authorBotFace",
                 m.reply_to_id as "replyToId", reply.role as "replyToRole",
                 reply.content as "replyToContent",
                 coalesce(reply.original_author_bot_id, reply.author_bot_id) as "replyAuthorBotId",
                 coalesce(reply.original_author_name, reply_bot.name) as "replyAuthorBotName",
                 reply_bot.slug as "replyAuthorBotSlug", reply_bot.face as "replyAuthorBotFace",
                 coalesce((
                   select jsonb_agg(jsonb_build_object(
                     'emoji', grouped.emoji,
                     'count', grouped.count,
                     'reactedByMe', grouped.reacted_by_me
                   ) order by grouped.emoji)
                     from (
                       select reaction.emoji, count(*)::integer as count,
                              bool_or(reaction.user_id = ${auth.userId}) as reacted_by_me
                         from message_reactions reaction
                        where reaction.organization_id = m.organization_id
                          and reaction.thread_id = m.thread_id
                          and reaction.message_id = m.id
                        group by reaction.emoji
                     ) grouped
                 ), '[]'::jsonb) as reactions,
                 m.created_at as "createdAt"
            from (
              select recent.*
                from messages recent
               where recent.organization_id = ${auth.organizationId}
                 and recent.thread_id = ${thread.id}
               order by recent.sequence desc nulls first, recent.created_at desc, recent.id desc
               limit 1000
            ) m
            left join message_ingress ingress on ingress.organization_id = m.organization_id
              and ingress.thread_id = m.thread_id and ingress.message_id = m.id
              and ingress.user_id = ${auth.userId} and ingress.operation = 'thread.message.create'
            left join bots b on b.organization_id = m.organization_id and b.id = m.author_bot_id
            left join messages reply on reply.organization_id = m.organization_id
              and reply.thread_id = m.thread_id and reply.id = m.reply_to_id
            left join bots reply_bot on reply_bot.organization_id = reply.organization_id
              and reply_bot.id = reply.author_bot_id
            order by m.sequence asc nulls last, m.created_at asc, m.id asc
        `,
        tx<Array<Record<string, unknown>>>`
          select * from (
            select id, status, bot_id as "botId",
                   case when origin = 'bot_greeting' then '' else input end as input, origin,
                   output, usage, error_message as error, error_code as "errorCode",
                   model,
                   hermes_run_id as "hermesResponseId", created_at as "createdAt", started_at as "startedAt",
                   ended_at as "endedAt", updated_at as "lastEventAt", workflow_id as "workflowId",
                   step_index as "stepIndex", step_kind as "stepKind", stack_depth as "stackDepth",
                   case when group_state->>'phase' = 'synthesis' then 'synthesis' end as "groupPhase",
                   completion_kind as "completionKind",
                   case when status = 'unknown' or external_state = 'ambiguous' then 'needs_review' else null end as "recoveryState"
              from runs where organization_id = ${auth.organizationId} and thread_id = ${thread.id}
              order by created_at desc, id desc limit 500
          ) recent_runs
          order by "createdAt" asc, id asc
        `,
        tx<RunEventRecord[]>`
          select * from (
            select cursor, organization_id as "organizationId", thread_id as "threadId",
                   run_id as "runId", bot_id as "botId", turn_id as "turnId",
                   session_key as "sessionKey", lease_generation as "leaseGeneration",
                   sequence, type, payload, occurred_at as "occurredAt"
              from run_events where organization_id = ${auth.organizationId} and thread_id = ${thread.id}
              order by cursor desc limit 5000
          ) recent_events
          order by cursor asc
        `,
        tx<Array<{
          id: string; runId: string; threadId: string; botId: string | null; command: string | null;
          description: string | null; choices: unknown; status: string; createdAt: Date | string;
          reviewReason: string | null; reviewerReason: string | null;
        } & AlwaysGateRow>>`
          select a.id, a.run_id as "runId", a.thread_id as "threadId", r.bot_id as "botId",
                 a.command, a.description, a.choices, a.status, a.created_at as "createdAt",
                 a.decision_state as "decisionState", a.gate_kind as "gateKind", a.tool_key as "toolKey",
                 a.gate_args as "gateArgs",
                 a.decision_detail->>'reason' as "reviewReason",
                 a.decision_detail->>'reviewerReason' as "reviewerReason",
                 a.decision_detail->>'effectiveMode' as "effectiveMode",
                 (select o.permission_pipeline from organizations o where o.id = a.organization_id) as pipeline
            from approval_requests a
            join runs r on r.organization_id = a.organization_id and r.id = a.run_id
           where a.organization_id = ${auth.organizationId} and a.thread_id = ${thread.id}
             and a.status = 'pending' and a.forward_state = 'pending'
             and (a.decision_state is null or a.decision_state = 'awaiting_human')
           order by a.created_at asc
        `,
        readThreadGroup(tx, auth.organizationId, thread.groupId),
        tx<Array<Record<string, unknown>>>`
          select * from (
            select id, kind, status, root_run_id as "rootRunId", root_bot_id as "rootBotId",
                   autonomy_enabled as "autonomyEnabled",
                   notification_sequence as "notificationSequence",
                   used_steps as "usedSteps", max_steps as "maxSteps",
                   used_handoffs as "usedHandoffs", max_handoffs as "maxHandoffs",
                   used_tokens as "usedTokens", token_budget as "tokenBudget",
                   deadline_at as "deadlineAt", error_code as "errorCode", error_message as "errorMessage",
                   final_output as "finalOutput",
                   case when status = 'unknown' then 'needs_review' else null end as "recoveryState",
                   created_at as "createdAt", updated_at as "updatedAt"
              from workflows where organization_id = ${auth.organizationId} and thread_id = ${thread.id}
              order by created_at desc, id desc limit 500
          ) recent_workflows
          order by "createdAt" asc, id asc
        `,
      ]);
      const events = eventRows.map(organizationEventEnvelope);
      // Le fenêtrage vit ici et non en SQL : sa règle croise trois jeux lus en
      // parallèle (les runs conclus par leurs événements, les messages
      // assistants persistés, les runs récents), et l'exprimer en SQL
      // demanderait de corréler les trois requêtes pour un gain de lecture
      // marginal : les lignes sortent déjà par l'index (organization_id,
      // thread_id, cursor). Le gain visé est le poids de la réponse.
      const windowedEvents = windowThreadEvents(events, {
        window: eventWindow,
        preservedRunIds: preservedRunIds(runs, events),
        concludedRunIds: concludedRunIds(events),
        answeredRunIds: answeredRunIds(messages),
      });
      return {
        id: thread.id,
        botId: thread.botId,
        title: thread.title,
        botName: thread.botName,
        group,
        instructions: thread.instructions ?? "",
        model: thread.model ?? "",
        effectiveModel: thread.model ?? thread.runtimeModel ?? "",
        createdAt: isoInstant(thread.createdAt),
        updatedAt: isoInstant(thread.updatedAt),
        messages: messages.map(messageDto),
        // `model` est la colonne du run, donc le modèle qui a réellement
        // exécuté ce tour. `runtimeSession` reste nul : le gateway ne rend
        // aucun détail de session par run, et l'inventer serait mentir.
        runs: runs.map((run) => {
          const publicRun = { ...run };
          delete publicRun.origin;
          return {
            ...dateFields(publicRun),
            // Seul l'accueil est nommé : son chrono part de son démarrage (runClockStart).
            ...(run.origin === "bot_greeting" ? { origin: "bot_greeting" } : {}),
            status: publicRunStatus(run.status),
            model: typeof run.model === "string" && run.model.trim() ? run.model : null,
            runtimeSession: null,
          };
        }),
        events: windowedEvents,
        workflows: workflows.map((workflow) => ({
          ...dateFields(workflow),
          usedTokens: Number(workflow.usedTokens ?? 0),
          tokenBudget: Number(workflow.tokenBudget ?? 0),
          notificationSequence: Number(workflow.notificationSequence ?? 0),
        })),
        approvals: approvals.map((approval) => ({
          id: approval.id,
          runId: approval.runId,
          threadId: approval.threadId,
          botId: approval.botId,
          kind: approvalKind(approval),
          action: approval.command ?? "",
          detail: approval.description,
          choices: Array.isArray(approval.choices) ? approval.choices.map(String) : [],
          status: approval.status,
          requestedAt: isoInstant(approval.createdAt),
          respondedAt: null,
          review: approvalReview(approval.reviewReason, approval.reviewerReason),
          alwaysOffered: alwaysOffered(approval, auth),
          ...approvalGateView(approval),
        })),
        // Curseur et troncature se lisent sur les événements BRUTS : le
        // fenêtrage change ce qu'on envoie, jamais où en est le fil ni le fait
        // qu'une limite de lecture a coupé son histoire.
        cursor: snapshotCursor(events),
        organizationCursor,
        truncated: messages.length === 1000 || runs.length === 500 || events.length === 5000,
      };
    });
    return context.json(snapshot);
  });

  return routes;
}
