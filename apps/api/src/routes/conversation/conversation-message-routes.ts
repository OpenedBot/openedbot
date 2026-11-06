import type { SQL } from "bun";
import { Hono } from "hono";
import {
  attachmentPayload,
  composeRunInput,
  displayContent,
  rejectAttachments,
  type StoredAttachment,
} from "@openedbot/conversation/domain/attachments";
import {
  HANDOFF_NOTICE_KIND,
  ROOM_LIMITS,
  attributedInput,
  handoffFocusHref,
  handoffReceivedNotice,
  handoffSentNotice,
  type HandoffMention,
} from "@openedbot/roster/domain/bot-mode";
import { dmHandoffMention } from "@openedbot/conversation/domain/dm-handoff";
import { type GroupFollowUp, type GroupSendState } from "@openedbot/execution/domain/group-send";
import { recordRunReceiptsTx } from "@openedbot/execution/application/run-receipts";
import { appendRunEventsTx } from "@openedbot/execution/sql/run-events";
import { foldQueuedRunInputTx } from "@openedbot/execution/sql/run-columns";
import { admitUserTurnTx } from "@openedbot/execution/application/run-creation";
import { AUTONOMY_DEFAULTS, normalizeAutonomyPolicy } from "@openedbot/roster/domain/autonomous-workflow";
import { workflowNotificationEligible } from "@openedbot/notifications/domain/workflow-notifications";
import { FOLLOWUP_SUPERSEDE_CODE } from "@openedbot/contracts-errors";
import { FOLLOWUP_SUPERSEDE_MESSAGE, mergeFollowupInputs } from "@openedbot/conversation/domain/followup";
import { composeReplyRunInput, type ReplyPromptContext } from "@openedbot/conversation/domain/message-reply";
import {
  acceptedHandoffEvents,
  acceptedQueuedRun,
  acceptedQueuedWorkflow,
  acceptedUserMessage,
} from "@openedbot/conversation/domain/send-accepted";
import type { AppVariables } from "../identity/auth";
import type { BlobStore } from "../../infrastructure/blob-store";
import { objectKey } from "../../infrastructure/blob-store";
import type { Db } from "@openedbot/platform-db";
import { isUniqueViolation } from "@openedbot/platform-db";
import { claimReservedBlobsTx } from "@openedbot/conversation/sql/uncommitted-blobs";
import { admitWithStoredBlobs } from "./message-blob-admission";
import { RunTrace } from "@openedbot/platform-observability/run-trace";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import type { ApiConfig } from "../../infrastructure/config";
import { assertEntitled } from "@openedbot/identity/domain/entitlement";
import {
  canonicalMessageHash,
  completeMessageIngressTx,
  readIdempotencyKey,
  reserveMessageIngress,
} from "@openedbot/conversation/application/message-ingress";
import { requestRunCancellationTx } from "@openedbot/execution/application/run-cancellation";
import { readGroupDefaultResponder } from "@openedbot/roster/domain/groups";
import { subscriptionPort } from "@openedbot/platform-db/subscription-port";
import { attachmentError, openGroupSend, readAttachments, readPlanOnly, readReplyToId } from "./conversation-input";
import { followupDispositionTx, handoffRosterTx, logRunAdmission } from "./conversation-followup";

/** Longueur maximale d'un message opérateur (le texte est stocké puis rejoué à chaque run). */
const MAX_MESSAGE_INPUT_CHARS = 100_000;

/** L’envoi d’un message dans un fil : admission, follow-up d’un run en cours, ou nouveau run. */
export function conversationMessageRoutes(db: Db, blobs: BlobStore, config: ApiConfig): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/:threadId/messages", async (context) => {
    const trace = new RunTrace();
    const auth = context.get("auth");
    const body = await jsonBody(context.req.raw);
    const rawInput = typeof body.input === "string" ? body.input : "";
    // Borne le texte persisté en jsonb puis rejoué à chaque run du fil.
    if (rawInput.length > MAX_MESSAGE_INPUT_CHARS) {
      throw new HttpError(413, "MESSAGE_TOO_LONG", "Le message dépasse la taille maximale.");
    }
    const input = rawInput.trim();
    const replyToId = readReplyToId(body.replyToId);
    const planOnly = readPlanOnly(body.planOnly);
    const attachments = readAttachments(body.attachments);
    if (!input && attachments.length === 0) throw new HttpError(400, "MESSAGE_EMPTY", "Le message est vide.");
    const rejection = rejectAttachments(attachments);
    if (rejection) throw new HttpError(413, rejection.code, attachmentError(rejection));

    const idempotencyKey = readIdempotencyKey(context.req.header("Idempotency-Key"));
    const requestHash = idempotencyKey ? canonicalMessageHash(input, attachments, { replyToId, planOnly }) : null;
    const ingress = idempotencyKey
      ? await reserveMessageIngress({
          db,
          auth,
          threadId: context.req.param("threadId"),
          key: idempotencyKey,
          requestHash: requestHash!,
          attachments,
          objectKey: (id) => objectKey(auth.organizationId, id),
        })
      : null;
    if (ingress?.kind === "replay") {
      context.header("Idempotency-Replayed", "true");
      return context.json(ingress.body, ingress.status as 202);
    }
    if (ingress) trace.mark("api.ingress_reserved");
    const reservation = ingress?.kind === "reserved" ? ingress.reservation : null;
    const ids = reservation?.attachments.map((item) => item.id) ?? attachments.map(() => crypto.randomUUID());
    const keys = reservation?.attachments.map((item) => item.key) ?? ids.map((id) => objectKey(auth.organizationId, id));
    try {
      const result = await admitWithStoredBlobs({
        db, blobs, organizationId: auth.organizationId, legacy: !reservation,
        objects: attachments.map((attachment, index) => ({ key: keys[index]!, ...attachmentPayload(attachment) })),
        onStored: () => trace.mark("api.blobs_stored"),
      }, async (tx) => {
        const plan = await subscriptionPort().readForUpdate(tx, auth.organizationId);
        const subscription = plan ? { status: plan.status, quota: plan.attachmentQuotaBytes } : undefined;
        const deletionRows = await tx<Array<{ pending: boolean }>>`
          select exists(
            select 1 from tenant_deletions
             where organization_id = ${auth.organizationId} and reason = 'account_deleted'
          ) as pending
        `;
        if (deletionRows[0]?.pending) {
          throw new HttpError(
            409,
            "ACCOUNT_DELETION_PENDING",
            "Le compte est en attente de suppression. Annulez la demande avant tout nouveau message.",
          );
        }
        assertEntitled(
          config.billingEnforced,
          subscription,
          "Les nouveaux runs sont bloqués tant que l’abonnement n’est pas actif.",
        );
        const usedRows = await tx<Array<{ used: string | number }>>`
          select coalesce(sum(bytes), 0) as used from attachments
           where organization_id = ${auth.organizationId} and deleted_at is null
        `;
        const newBytes = attachments.reduce((sum, item) => sum + attachmentPayload(item).data.byteLength, 0);
        const quotaBytes = subscription ? Number(subscription.quota) : Number.MAX_SAFE_INTEGER;
        if (Number(usedRows[0]?.used ?? 0) + newBytes > quotaBytes) {
          throw new HttpError(413, "ATTACHMENT_QUOTA_EXCEEDED", "Le quota de fichiers de l’organisation est atteint.");
        }
        const threadRows = await tx<Array<{
          id: string;
          botId: string | null;
          groupId: string | null;
          botName: string | null;
          botSlug: string | null;
          groupDefaultResponder: unknown;
          groupAnswerMode: string | null;
        }>>`
          select t.id, t.bot_id as "botId", t.group_id as "groupId", b.name as "botName", b.slug as "botSlug",
                 g.default_responder as "groupDefaultResponder", g.answer_mode as "groupAnswerMode"
            from threads t
            left join bots b on b.organization_id = t.organization_id and b.id = t.bot_id
            left join bot_groups g on g.organization_id = t.organization_id and g.id = t.group_id
           where t.organization_id = ${auth.organizationId}
             and t.id = ${context.req.param("threadId")} for update of t
        `;
        const thread = threadRows[0];
        if (!thread) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
        const importing = await tx<Array<{ slug: string }>>`
          select i.slug from profile_import_items i
           where i.organization_id = ${auth.organizationId} and i.reservation_released_at is null
             and (i.bot_id = ${thread.botId}::uuid or exists (
               select 1 from group_members gm where gm.organization_id = i.organization_id
                 and gm.group_id = ${thread.groupId}::uuid and gm.bot_id = i.bot_id
             )) limit 1
        `;
        if (importing.length) throw new HttpError(409, "PROFILE_IMPORT_IN_PROGRESS", "Un profil de cette conversation est encore en cours d’import ou à vérifier. Consultez son rapport dans les réglages Hermes.");
        const replyTarget = replyToId
          ? (await tx<Array<ReplyPromptContext & { authorBotId: string | null }>>`
              select message.id, message.role, message.content,
                     coalesce(message.original_author_name, author.name) as "authorName",
                     coalesce(message.original_author_bot_id, message.author_bot_id) as "authorBotId"
                from messages message
                left join bots author on author.organization_id = message.organization_id
                  and author.id = message.author_bot_id
               where message.organization_id = ${auth.organizationId}
                 and message.thread_id = ${thread.id}
                 and message.id = ${replyToId}
            `)[0] ?? null
          : null;
        if (replyToId && !replyTarget) {
          throw new HttpError(404, "REPLY_TARGET_NOT_FOUND", "Le message cité n’existe pas dans cette conversation.");
        }
        const messageId = reservation?.messageId ?? crypto.randomUUID();
        const runId = reservation?.runId ?? crypto.randomUUID();
        // Réservé d'avance (ingress idempotent), mais le workflow n'est créé
        // que si l'envoi a un état durable : salon, hand-off ou autonomie.
        const reservedWorkflowId = reservation?.workflowId ?? crypto.randomUUID();
        const stored = attachments.map<StoredAttachment>((attachment, index) => ({ ...attachment, id: ids[index]! }));
        // Salon : l'envoi s'ouvre via `initGroupSend` : le premier orateur est le
        // premier membre mentionné (tout le monde à défaut), et son run porte
        // l'état de l'envoi. Fil DM : le bot du fil, sans état de salon, sauf
        // mention `@slug` d'un autre bot, qui démarre la cible dans CE fil
        // (workflow same-thread, pas de courrier).
        let workflowKind: "dm" | "group" = thread.groupId ? "group" : "dm";
        let workflowRootBotId = thread.botId;
        let workflowUsedHandoffs = 0;
        let runBotId: string;
        let runInput = composeReplyRunInput(composeRunInput(input, attachments), replyTarget);
        let runStepKind: "root" | "delegated" | "group" = thread.groupId ? "group" : "root";
        let runStackDepth = 0;
        let runCallerBotId: string | null = null;
        let delegationNotice: HandoffMention | null = null;
        let steerTargetRunId: string | null = null;
        const receiptAttemptIds: string[] = [];
        let groupPosition: number | null = null;
        let groupState: GroupSendState | null = null;
        if (thread.groupId) {
          const members = await tx<Array<{ id: string; slug: string; position: number }>>`
            select b.id, b.slug, gm.position from group_members gm
              join bots b on b.organization_id = gm.organization_id and b.id = gm.bot_id
             where gm.organization_id = ${auth.organizationId} and gm.group_id = ${thread.groupId}
               and b.archived_at is null
             order by gm.position asc
          `;
          // Message sans mention : il peut poursuivre une conversation adressée
          // (`followUpAddressees`). D'où le message précédent de l'opérateur
          // et l'auteur de la dernière réponse du salon.
          const previous = await tx<Array<{ text: string | null; lastSpeakerId: string | null }>>`
            select (
                     select string_agg(part->>'text', ' ')
                       from messages operator_message,
                            jsonb_array_elements(operator_message.content) part
                      where operator_message.id = (
                        select m.id from messages m
                         where m.organization_id = ${auth.organizationId} and m.thread_id = ${thread.id}
                           and m.role = 'user' and m.author_bot_id is null and m.id <> ${messageId}
                         order by m.sequence desc nulls last, m.created_at desc limit 1
                      )
                        and part->>'type' = 'text'
                   ) as text,
                   (
                     select coalesce(m.original_author_bot_id, m.author_bot_id) from messages m
                      where m.organization_id = ${auth.organizationId} and m.thread_id = ${thread.id}
                        and m.role = 'assistant'
                      order by m.sequence desc nulls last, m.created_at desc limit 1
                   ) as "lastSpeakerId"
          `;
          const followUp: GroupFollowUp | undefined = previous[0]?.text
            ? { previousOperatorText: previous[0].text, lastSpeakerId: previous[0].lastSpeakerId }
            : undefined;
          const speaker = openGroupSend(
            input,
            members,
            readGroupDefaultResponder(thread.groupDefaultResponder, members.map((member) => member.id)),
            followUp,
            replyTarget?.role === "assistant" ? replyTarget.authorBotId : null,
            thread.groupAnswerMode === "team",
          );
          runBotId = speaker.botId;
          workflowRootBotId = speaker.botId;
          groupPosition = speaker.position;
          groupState = speaker.state;
        } else {
          if (!thread.botId) throw new HttpError(409, "THREAD_HAS_NO_BOT", "Cette conversation n’a aucun bot actif.");
          const roster = await handoffRosterTx(tx, auth.organizationId, thread.botId);
          const mention = dmHandoffMention(input, thread.botId, roster);
          if (mention) {
            // Une mention explicite démarre la cible dans le fil d'origine. Le
            // bot source reste le caller et reprendra automatiquement pour la
            // synthèse : aucun second fil, aucun courrier volatile.
            runBotId = mention.botId;
            runStepKind = "delegated";
            runStackDepth = 1;
            runCallerBotId = thread.botId;
            delegationNotice = mention;
            workflowUsedHandoffs = 1;
            runInput = attributedInput(
              { name: thread.botName ?? "bot", slug: thread.botSlug ?? "bot" },
              composeReplyRunInput(composeRunInput(mention.message, attachments), replyTarget),
            );
          } else {
            runBotId = thread.botId;
          }
        }
        // Un steer ne change jamais la décision de routage : uniquement un DM
        // texte, sans citation/pièce jointe/handoff, vers LE bot déjà actif du
        // fil. Le run créé ci-dessous reste le repli FIFO jusqu'à l'ACK
        // Hermes; il n'est neutralisé qu'ensuite par le worker.
        const disposition = await followupDispositionTx(tx, {
          organizationId: auth.organizationId,
          threadId: thread.id,
          botId: runBotId,
          groupId: thread.groupId,
          initiatorUserId: auth.userId,
          input,
          attachmentCount: attachments.length,
          replyToId,
          handoff: delegationNotice !== null,
          planOnly,
        });
        steerTargetRunId = disposition.kind === "steer"
          ? disposition.runId
          : disposition.kind === "enqueue"
            ? disposition.targetRunId
            : null;
        trace.mark("api.routed");
        trace.set("disposition", disposition.kind);
        trace.set("workflow_kind", workflowKind);
        if (disposition.kind === "fold" || disposition.kind === "enqueue") {
          // Le run précédent n'a pas encore été réclamé : le message rejoint
          // son entrée et le bot répond aux deux d'un coup. Aucun nouveau run,
          // aucun workflow : la réponse porte les identifiants du run replié.
          // `enqueue` est le même geste sur le repli déjà posé d'un steer
          // pending : on allonge aussi le texte de la tentative, sans second
          // workflow.
          await foldQueuedRunInputTx(tx as unknown as SQL, { organizationId: auth.organizationId, id: disposition.runId }, runInput);
          if (disposition.kind === "enqueue") await tx`
            update run_steering_attempts set text = text || E'\n\n' || ${input}, updated_at = now()
             where organization_id = ${auth.organizationId} and id = ${disposition.attemptId}
               and status = 'pending'
               and char_length(text) + char_length(${input}) + 2 <= 65536
          `;
          await tx`
            insert into messages (id, organization_id, thread_id, run_id, role, content, reply_to_id)
            values (${messageId}, ${auth.organizationId}, ${context.req.param("threadId")}, ${disposition.runId},
                    'user', ${displayContent(input, stored)}, ${replyToId})
          `;
          await tx`
            update threads set updated_at = now()
             where organization_id = ${auth.organizationId} and id = ${context.req.param("threadId")}
          `;
          const foldedAt = new Date().toISOString();
          const folded = {
            runId: disposition.runId,
            workflowId: disposition.workflowId,
            status: "queued",
            notificationEligible: workflowNotificationEligible({
              kind: thread.groupId ? "group" : "dm",
              autonomyEnabled: disposition.autonomyEnabled,
            }),
            workflowUpdatedAt: foldedAt,
            foldedIntoRunId: disposition.runId,
            ...(disposition.kind === "enqueue" ? { steerTargetRunId: disposition.targetRunId } : {}),
            message: acceptedUserMessage({
              id: messageId,
              clientSubmissionId: idempotencyKey,
              runId: disposition.runId,
              text: input,
              stored,
              replyTarget,
              createdAt: foldedAt,
            }),
          };
          if (reservation) await completeMessageIngressTx(tx, auth.organizationId, reservation, 202, folded);
          await recordRunReceiptsTx(tx, { organizationId: auth.organizationId, messageIds: [messageId] });
          return folded;
        }
        if (disposition.kind === "supersede") {
          // Grok Bot : le tour qui réfléchissait encore est remplacé par un
          // tour qui porte SON entrée, les steers qu'il avait déjà reçus, puis
          // le nouveau message. Une seule réponse, dans l'ordre d'envoi.
          runInput = mergeFollowupInputs([...disposition.texts, ...disposition.steerTexts, runInput]);
        }
        const requiredBotIds = [...new Set([
          runBotId,
          runCallerBotId,
          thread.botId,
        ].filter((id): id is string => Boolean(id)))].sort();
        const activeBots = await tx<Array<{
          id: string;
          autonomyEnabled: boolean;
          autonomyMaxDepth: number;
          autonomyMaxSteps: number;
          autonomyMaxHandoffs: number;
          autonomyTimeoutSeconds: number;
          autonomyTokenBudget: number;
        }>>`
          select id, autonomy_enabled as "autonomyEnabled", autonomy_max_depth as "autonomyMaxDepth",
                 autonomy_max_steps as "autonomyMaxSteps", autonomy_max_handoffs as "autonomyMaxHandoffs",
                 autonomy_timeout_seconds as "autonomyTimeoutSeconds", autonomy_token_budget as "autonomyTokenBudget"
            from bots where organization_id = ${auth.organizationId}
            and id in ${tx(requiredBotIds)} and archived_at is null
           order by id for update
        `;
        if (activeBots.length !== requiredBotIds.length) {
          throw new HttpError(409, "WORKFLOW_BOT_UNAVAILABLE", "Un bot requis a été archivé ou supprimé.");
        }
        // Un DM appartient au bot du fil, même quand l'opérateur adresse
        // directement une cible. Un salon appartient à l'orateur effectivement
        // sélectionné par les mentions. Dans les deux cas la policy est relue
        // sous le même verrou que la disponibilité et figée dans le workflow.
        const policyBotId = thread.groupId ? runBotId : thread.botId;
        const policyBot = activeBots.find((bot) => bot.id === policyBotId);
        if (!policyBot) {
          throw new HttpError(409, "WORKFLOW_BOT_UNAVAILABLE", "Le bot porteur de la policy est indisponible.");
        }
        const policy = normalizeAutonomyPolicy({
          enabled: policyBot.autonomyEnabled ?? AUTONOMY_DEFAULTS.enabled,
          maxDepth: policyBot.autonomyMaxDepth ?? AUTONOMY_DEFAULTS.maxDepth,
          maxSteps: policyBot.autonomyMaxSteps ?? AUTONOMY_DEFAULTS.maxSteps,
          maxHandoffs: policyBot.autonomyMaxHandoffs ?? AUTONOMY_DEFAULTS.maxHandoffs,
          timeoutSeconds: policyBot.autonomyTimeoutSeconds ?? AUTONOMY_DEFAULTS.timeoutSeconds,
          tokenBudget: policyBot.autonomyTokenBudget ?? AUTONOMY_DEFAULTS.tokenBudget,
        });
        // Un salon peut appeler jusqu'à 6 membres × 3 rounds. Les 10 messages
        // sont comptés séparément dans GroupSendState et les pass ne les
        // consomment pas ; `autonomy_max_steps` ne doit donc jamais tronquer
        // le round-robin de base.
        const workflowMaxSteps = thread.groupId
          ? ROOM_LIMITS.maxMemberTurns
          : delegationNotice ? Math.max(policy.maxSteps, 2) : policy.maxSteps;
        // La mention de l'opérateur est une instruction humaine : elle reste
        // autorisée avec autonomie désactivée ou maxHandoffs=0. Le snapshot
        // réserve toutefois la transmission déjà consommée et la synthèse.
        const workflowMaxHandoffs = delegationNotice ? Math.max(policy.maxHandoffs, 1) : policy.maxHandoffs;
        const workflowUpdatedAt = new Date().toISOString();
        // Un steer n'ouvre pas de workflow : le tour occupé garde le sien.
        // Le run créé ci-dessous est le repli FIFO, pas un second workflow
        // autonome. DM simple : déjà sans workflow.
        const workflowId = steerTargetRunId
          ? null
          : (thread.groupId || delegationNotice || policy.enabled ? reservedWorkflowId : null);
        trace.set("workflow", workflowId !== null);
        await admitUserTurnTx(tx, {
          organizationId: auth.organizationId,
          threadId: thread.id,
          runId,
          initiatorUserId: auth.userId,
          input: runInput,
          planOnly,
          speaker: runStepKind === "group"
            ? { kind: "group", botId: runBotId, position: groupPosition, state: groupState }
            : runStepKind === "delegated"
              ? { kind: "delegated", botId: runBotId, callerBotId: runCallerBotId! }
              : { kind: "root", botId: runBotId },
          workflow: workflowId
            ? {
                id: workflowId,
                kind: workflowKind,
                rootBotId: workflowRootBotId,
                budget: { ...policy, maxSteps: workflowMaxSteps, maxHandoffs: workflowMaxHandoffs },
              }
            : null,
          admissionTimeoutSeconds: policy.timeoutSeconds,
        });
        trace.mark("api.run_created");
        if (steerTargetRunId) {
          const attemptId = crypto.randomUUID();
          receiptAttemptIds.push(attemptId);
          await tx`
          insert into run_steering_attempts (
            id, organization_id, thread_id, target_run_id, source_run_id, text, status
          ) values (
            ${attemptId}, ${auth.organizationId}, ${thread.id}, ${steerTargetRunId},
            ${runId}, ${input}, 'pending'
          )
        `;
        }
        if (disposition.kind === "supersede") {
          // Le nouveau run est en base avant que l'ancien reçoive son arrêt :
          // la file le réclame dès que l'ancien est réglé. Les steers déjà
          // confirmés sur l'ancien voyagent dans la nouvelle entrée, et ne
          // seront donc jamais rejoués depuis `pending_steer`.
          await requestRunCancellationTx(tx, auth.organizationId, disposition.runId, {
            code: FOLLOWUP_SUPERSEDE_CODE,
            message: FOLLOWUP_SUPERSEDE_MESSAGE,
          });
          const supersededReceipts = await tx<Array<{ id: string }>>`
            update run_steering_attempts set error_code = 'HERMES_STEER_SUPERSEDED', updated_at = now()
             where organization_id = ${auth.organizationId} and target_run_id = ${disposition.runId}
               and status = 'confirmed' and error_code is null
             returning id
          `;
          receiptAttemptIds.push(...supersededReceipts.map((row) => row.id));
        }
        const sentNotice = delegationNotice
          ? {
              message: handoffSentNotice(delegationNotice),
              kind: HANDOFF_NOTICE_KIND.sent,
              targetBotId: delegationNotice.botId,
            }
          : null;
        const receivedNotice = delegationNotice
          ? {
              message: handoffReceivedNotice({
                name: thread.botName ?? "bot",
                slug: thread.botSlug ?? "bot",
              }),
              kind: HANDOFF_NOTICE_KIND.received,
              originSlug: thread.botSlug ?? "bot",
              href: handoffFocusHref(thread.botSlug ?? "bot", runId),
              targetBotId: delegationNotice.botId,
            }
          : null;
        if (delegationNotice && sentNotice && receivedNotice) {
          // The run is new: the primitive numbers its notices 0 and 1.
          await appendRunEventsTx(tx as unknown as SQL, [
            { organizationId: auth.organizationId, threadId: thread.id, runId, type: "system.notice", payload: sentNotice },
            {
              organizationId: auth.organizationId, threadId: delegationNotice.threadId, runId,
              type: "system.notice", payload: receivedNotice,
            },
          ]);
          await tx`
            update threads set updated_at = now()
             where organization_id = ${auth.organizationId} and id = ${delegationNotice.threadId}
          `;
        }
        if (thread.groupId) {
          // L'opérateur a répondu : l'escalade `needs_you` du salon retombe.
          await tx`
            update bot_groups set needs_you = false, updated_at = now()
             where organization_id = ${auth.organizationId} and id = ${thread.groupId}
          `;
        }
        await tx`
          insert into messages (id, organization_id, thread_id, run_id, role, content, reply_to_id)
          values (${messageId}, ${auth.organizationId}, ${context.req.param("threadId")}, ${runId},
                  'user', ${displayContent(input, stored)}, ${replyToId})
        `;
        for (let index = 0; index < attachments.length; index += 1) {
          const attachment = attachments[index]!;
          const payload = attachmentPayload(attachment);
          await tx`
            insert into attachments (
              id, organization_id, message_id, object_key, driver, name, content_type, kind, bytes
            ) values (
              ${ids[index]!}, ${auth.organizationId}, ${messageId}, ${keys[index]!}, ${blobs.driver},
              ${attachment.name}, ${attachment.contentType}, ${attachment.kind}, ${payload.data.byteLength}
            )
          `;
        }
        if (!reservation) await claimReservedBlobsTx(tx, auth.organizationId, keys);
        await tx`
          update threads set updated_at = now()
           where organization_id = ${auth.organizationId} and id = ${context.req.param("threadId")}
        `;
        const response = {
          runId,
          workflowId,
          // Le POST /steer n'est pas encore parti à cet instant : annoncer
          // « steering » serait un faux succès. Le run de repli est bien
          // queued jusqu'à l'ACK Hermes, puis le worker le clôt.
          status: "queued",
          notificationEligible: workflowNotificationEligible({
            kind: workflowKind,
            autonomyEnabled: steerTargetRunId ? false : policy.enabled,
          }),
          workflowUpdatedAt,
          ...(steerTargetRunId ? { steerTargetRunId } : {}),
          ...(disposition.kind === "supersede" ? { supersededRunId: disposition.runId } : {}),
          message: acceptedUserMessage({
            id: messageId,
            clientSubmissionId: idempotencyKey,
            runId,
            text: input,
            stored,
            replyTarget,
            createdAt: workflowUpdatedAt,
          }),
          run: acceptedQueuedRun({
            id: runId,
            botId: runBotId,
            text: runInput,
            workflowId,
            stepKind: runStepKind,
            stackDepth: runStackDepth,
            createdAt: workflowUpdatedAt,
          }),
          ...(workflowId
            ? { workflow: acceptedQueuedWorkflow({
                id: workflowId,
                kind: workflowKind,
                rootRunId: runId,
                rootBotId: workflowRootBotId,
                autonomyEnabled: policy.enabled,
                maxSteps: workflowMaxSteps,
                maxHandoffs: workflowMaxHandoffs,
                usedHandoffs: workflowUsedHandoffs,
                tokenBudget: policy.tokenBudget,
                timeoutSeconds: policy.timeoutSeconds,
                createdAt: workflowUpdatedAt,
              }) }
            : {}),
          ...(sentNotice && receivedNotice
            ? { events: acceptedHandoffEvents({
                runId,
                createdAt: workflowUpdatedAt,
                sent: sentNotice,
                received: receivedNotice,
              }) }
            : {}),
        };
        if (reservation) await completeMessageIngressTx(tx, auth.organizationId, reservation, 202, response);
        await recordRunReceiptsTx(tx, {
          organizationId: auth.organizationId, messageIds: [messageId], attemptIds: receiptAttemptIds,
        });
        return response;
      });
      trace.mark("api.committed");
      logRunAdmission(result.runId, auth.organizationId, trace);
      return context.json(result, 202);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "THREAD_BUSY", "Cette conversation a déjà un run en attente ou en cours.");
      }
      throw error;
    }
  });

  return routes;
}
