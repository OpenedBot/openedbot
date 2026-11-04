import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HermesClient, type HermesClientConfig } from "@openedbot/hermes";
import {
  composeRunInput,
  documentAttachment,
  imageAttachment,
  type MessageAttachmentInput,
} from "@openedbot/conversation/domain/attachments";
import {
  HANDOFF_NOTICE_KIND,
  attributedInput,
  handoffSentNotice,
  type BotIdentity,
} from "@openedbot/roster/domain/bot-mode";
import {
  AUTONOMY_DEFAULTS,
  normalizeAutonomyPolicy,
  workflowSessionKey,
} from "@openedbot/roster/domain/autonomous-workflow";
import { runtimeToolsetContractMessage, runtimeToolsetContractViolation } from "@openedbot/runtimes/domain/runtime-contract";
import { messageVersionPrecondition } from "@openedbot/conversation/domain/message-version";
import { workflowNotificationEligible } from "@openedbot/notifications/domain/workflow-notifications";
import type {
  CreateMessageVersionInput,
  MessageVersionCreatedDto,
  MessageVersionFamilyDto,
  MessageVersionLinkDto,
} from "@openedbot/contracts-api";
import type { MessageContent } from "@openedbot/contracts-api";
import type { AppVariables } from "../identity/auth";
import type { BlobStore } from "../../infrastructure/blob-store";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { isUniqueViolation, withTenant } from "@openedbot/platform-db";
import { assertEntitled } from "@openedbot/identity/domain/entitlement";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";
import { readIdempotencyKey } from "@openedbot/conversation/application/message-ingress";
import { dmHandoffMention } from "@openedbot/conversation/domain/dm-handoff";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";
import { subscriptionPort } from "@openedbot/platform-db/subscription-port";
import { assertSourceEligible, readSource } from "./message-version-source";

const OPERATION = "thread.message.version.create";
const MAX_INPUT_CHARS = 100_000;
const MAX_COPIED_MESSAGES = 200;
const ACTIVE_RUN_STATUSES = ["queued", "starting", "running", "awaiting_approval", "relaying", "unknown"] as const;

type RuntimeReader = typeof readRuntimeSecret;
type ToolsetClient = Pick<HermesClient, "toolsets">;

type VersionRow = {
  rootThreadId: string;
  rootMessageId: string;
  parentThreadId: string;
  parentMessageId: string;
  branchThreadId: string;
  branchMessageId: string;
  runId: string;
  workflowId: string;
  kind: "edit" | "regenerate";
  ordinal: number | string;
  requestHash?: string;
  autonomyEnabled?: boolean;
};

type CopiedMessage = {
  id: string;
  role: "user" | "assistant";
  content: MessageContent;
  authorBotId: string | null;
  originalAuthorBotId: string | null;
  originalAuthorName: string | null;
  replyToId: string | null;
  createdAt: Date | string;
};

export function messageVersionRoutes(
  db: Db,
  blobs: BlobStore,
  config: ApiConfig,
  dependencies: {
    readRuntime?: RuntimeReader;
    clientFactory?: (clientConfig: HermesClientConfig) => ToolsetClient;
  } = {},
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:threadId/message-versions", async (context) => {
    const auth = context.get("auth");
    const threadId = context.req.param("threadId");
    const families = await withTenant(db, auth.organizationId, async (tx) => {
      const exists = await tx<Array<{ id: string }>>`
        select id from threads where organization_id = ${auth.organizationId} and id = ${threadId}
      `;
      if (!exists[0]) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
      return readVersionFamilies(tx, auth.organizationId, threadId);
    });
    return context.json({ families });
  });

  routes.post("/:threadId/messages/:messageId/versions", async (context) => {
    const auth = context.get("auth");
    const sourceThreadId = context.req.param("threadId");
    const sourceMessageId = context.req.param("messageId");
    const body = readCreateInput(await jsonBody(context.req.raw));
    const key = readIdempotencyKey(context.req.header("Idempotency-Key"));
    if (!key) {
      throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key est requise pour créer une variante.");
    }
    const requestHash = versionRequestHash(sourceThreadId, sourceMessageId, body);

    // A lost 201 is replayed before the PVE probe. Once committed, a runtime
    // outage must not turn the same logical operation into a false failure.
    const existing = await withTenant(db, auth.organizationId, async (tx) =>
      readVersionByKey(tx, auth.organizationId, auth.userId, key));
    if (existing) {
      assertSameRequest(existing.requestHash!, requestHash);
      context.header("Idempotency-Replayed", "true");
      return context.json(publicCreated(existing, sourceThreadId, sourceMessageId, true), 200);
    }

    await assertPveReady(db, config, auth.organizationId, dependencies);

    // Message rows are append-only. Read the immutable attachment manifest
    // and payload outside the write transaction, then re-check the source and
    // all stateful gates under locks below. A missing legacy blob fails
    // explicitly; it is never silently dropped from the regenerated prompt.
    const sourceAttachments = await withTenant(db, auth.organizationId, async (tx) => {
      const source = await readSource(tx, auth.organizationId, sourceThreadId, sourceMessageId, false);
      assertSourceEligible(source, auth.userId);
      return loadSourceAttachments(tx, blobs, auth.organizationId, source.content);
    });

    try {
      const created = await withTenant(db, auth.organizationId, async (tx) => {
        const plan = await subscriptionPort().readForUpdate(tx, auth.organizationId);
        assertEntitled(
          config.billingEnforced,
          plan ? { status: plan.status } : null,
          "Les nouvelles variantes sont bloquées tant que l’abonnement n’est pas actif.",
        );

        const source = await readSource(tx, auth.organizationId, sourceThreadId, sourceMessageId, true);
        assertSourceEligible(source, auth.userId);
        const sourceText = messageText(source.content);
        const input = body.mode === "edit"
          ? assertString(body.input, "Le message modifié", { max: MAX_INPUT_CHARS })
          : sourceText;
        if (!input) throw new HttpError(409, "MESSAGE_VERSION_EMPTY", "Le message source ne contient aucun texte régénérable.");

        await assertThreadIdle(tx, auth.organizationId, source.threadId);
        const ancestry = await readSourceAncestry(tx, auth.organizationId, source.threadId, source.messageId);
        const rootThreadId = ancestry?.rootThreadId ?? source.threadId;
        const rootMessageId = ancestry?.rootMessageId ?? source.messageId;
        await tx`
          select pg_advisory_xact_lock(
            hashtext(${auth.organizationId}), hashtext(${`${rootThreadId}:${rootMessageId}`})
          )
        `;

        // A concurrent request may have committed while the PVE probe was in
        // flight. Re-check under the family lock and replay only exact input.
        const replay = await readVersionByKey(tx, auth.organizationId, auth.userId, key);
        if (replay) {
          assertSameRequest(replay.requestHash!, requestHash);
          return { row: replay, duplicate: true };
        }
        const countRows = await tx<Array<{ count: number | string }>>`
          select count(*) as count from message_versions
           where organization_id = ${auth.organizationId}
             and root_thread_id = ${rootThreadId} and root_message_id = ${rootMessageId}
        `;
        const precondition = messageVersionPrecondition(
          Number(countRows[0]?.count ?? 0),
          body.expectedVersionCount,
        );
        if (precondition.kind === "conflict") {
          throw new HttpError(
            409,
            "MESSAGE_VERSION_CONFLICT",
            "Une autre variante a été créée. Actualisez l’historique puis réessayez.",
          );
        }
        if (precondition.kind === "limit") {
          throw new HttpError(409, "MESSAGE_VERSION_LIMIT_REACHED", "Cette famille conserve au plus 20 versions.");
        }

        const bots = await tx<Array<{
          id: string;
          name: string;
          slug: string;
          autonomyEnabled: boolean;
          autonomyMaxDepth: number;
          autonomyMaxSteps: number;
          autonomyMaxHandoffs: number;
          autonomyTimeoutSeconds: number;
          autonomyTokenBudget: number | string;
        }>>`
          select id, name, slug, autonomy_enabled as "autonomyEnabled",
                 autonomy_max_depth as "autonomyMaxDepth", autonomy_max_steps as "autonomyMaxSteps",
                 autonomy_max_handoffs as "autonomyMaxHandoffs",
                 autonomy_timeout_seconds as "autonomyTimeoutSeconds",
                 autonomy_token_budget as "autonomyTokenBudget"
            from bots where organization_id = ${auth.organizationId} and id = ${source.botId}
              and archived_at is null for update
        `;
        const rootBot = bots[0];
        if (!rootBot) throw new HttpError(409, "WORKFLOW_BOT_UNAVAILABLE", "Le bot de cette tâche est indisponible.");
        const taskCount = await tx<Array<{ count: number | string }>>`
          select count(*) as count from threads
           where organization_id = ${auth.organizationId} and bot_id = ${rootBot.id}
        `;
        if (Number(taskCount[0]?.count ?? 0) >= 100) {
          throw new HttpError(409, "BOT_TASK_LIMIT_REACHED", "Un bot conserve au plus 100 tâches.");
        }

        const prefix = await tx<CopiedMessage[]>`
          select message.id, message.role, message.content, message.author_bot_id as "authorBotId",
                 message.original_author_bot_id as "originalAuthorBotId",
                 message.original_author_name as "originalAuthorName", message.reply_to_id as "replyToId",
                 message.created_at as "createdAt"
            from messages message
            left join runs source_run on source_run.organization_id = message.organization_id
              and source_run.id = message.run_id
           where message.organization_id = ${auth.organizationId}
             and message.thread_id = ${source.threadId} and message.sequence < ${source.sequence}
             and (message.run_id is null or source_run.status = 'completed')
           order by message.sequence desc limit ${MAX_COPIED_MESSAGES + 1}
        `;
        const prefixTruncated = prefix.length > MAX_COPIED_MESSAGES;
        const copied = prefix.slice(0, MAX_COPIED_MESSAGES).reverse();

        const workflowId = crypto.randomUUID();
        const runId = crypto.randomUUID();
        const branchThreadId = crypto.randomUUID();
        const branchMessageId = crypto.randomUUID();
        const versionId = crypto.randomUUID();
        const ordinal = precondition.ordinal;
        const titleSuffix = body.mode === "edit" ? `Variante ${ordinal + 1}` : `Régénération ${ordinal + 1}`;
        const title = `${source.threadTitle} · ${titleSuffix}`.slice(0, 80);
        await tx`
          insert into threads (
            id, organization_id, bot_id, title, hermes_session_id, is_default
          ) values (
            ${branchThreadId}, ${auth.organizationId}, ${rootBot.id}, ${title},
            ${`ohb:${auth.organizationId}:${branchThreadId}`}, false
          )
        `;

        const copiedIds = new Map<string, string>();
        for (const message of copied) copiedIds.set(message.id, crypto.randomUUID());
        for (const message of copied) {
          await tx`
            insert into messages (
              id, organization_id, thread_id, run_id, role, content, author_bot_id,
              original_author_bot_id, original_author_name, reply_to_id, created_at
            ) values (
              ${copiedIds.get(message.id)!}, ${auth.organizationId}, ${branchThreadId}, null,
              ${message.role}, ${publicHistoryContent(message.content, message.role)},
              ${message.authorBotId}, ${message.originalAuthorBotId},
              ${message.originalAuthorName}, ${message.replyToId ? copiedIds.get(message.replyToId) ?? null : null},
              ${message.createdAt}
            )
          `;
        }

        const roster = await tx<BotIdentity[]>`
          select bot.id, bot.name, bot.slug, bot.description, default_thread.id as "threadId"
            from bots bot
            join threads default_thread on default_thread.organization_id = bot.organization_id
              and default_thread.bot_id = bot.id and default_thread.is_default
              
           where bot.organization_id = ${auth.organizationId} and bot.archived_at is null
             and bot.id <> ${rootBot.id}
        `;
        const mention = dmHandoffMention(input, rootBot.id, roster);
        let runBotId = rootBot.id;
        let runInput = composeRunInput(input, sourceAttachments);
        let stepKind: "root" | "delegated" = "root";
        let stackDepth = 0;
        let callerBotId: string | null = null;
        let executionSessionKey: string | null = null;
        let usedHandoffs = 0;
        if (mention) {
          runBotId = mention.botId;
          runInput = attributedInput(
            { name: rootBot.name, slug: rootBot.slug },
            composeRunInput(mention.message, sourceAttachments),
          );
          stepKind = "delegated";
          stackDepth = 1;
          callerBotId = rootBot.id;
          executionSessionKey = workflowSessionKey(auth.organizationId, workflowId, mention.botId);
          usedHandoffs = 1;
        }
        if (runBotId !== rootBot.id) {
          const target = await tx<Array<{ id: string }>>`
            select id from bots where organization_id = ${auth.organizationId} and id = ${runBotId}
              and archived_at is null for key share
          `;
          if (!target[0]) throw new HttpError(409, "WORKFLOW_BOT_UNAVAILABLE", "Le bot mentionné est indisponible.");
        }

        const policy = normalizeAutonomyPolicy({
          enabled: rootBot.autonomyEnabled ?? AUTONOMY_DEFAULTS.enabled,
          maxDepth: rootBot.autonomyMaxDepth ?? AUTONOMY_DEFAULTS.maxDepth,
          maxSteps: rootBot.autonomyMaxSteps ?? AUTONOMY_DEFAULTS.maxSteps,
          maxHandoffs: rootBot.autonomyMaxHandoffs ?? AUTONOMY_DEFAULTS.maxHandoffs,
          timeoutSeconds: rootBot.autonomyTimeoutSeconds ?? AUTONOMY_DEFAULTS.timeoutSeconds,
          tokenBudget: Number(rootBot.autonomyTokenBudget ?? AUTONOMY_DEFAULTS.tokenBudget),
        });
        const maxSteps = mention ? Math.max(policy.maxSteps, 2) : policy.maxSteps;
        const maxHandoffs = mention ? Math.max(policy.maxHandoffs, 1) : policy.maxHandoffs;
        const workflowUpdatedAt = new Date().toISOString();
        // La variante garde les restrictions du tour source : un plan reste un
        // plan, une routine sans attente le reste.
        await tx`
          insert into workflows (
            id, organization_id, thread_id, root_run_id, root_bot_id, initiator_user_id,
            kind, status, protocol_version, autonomy_enabled, max_depth, max_steps, max_handoffs,
            timeout_seconds, token_budget, used_steps, used_handoffs, used_tokens, deadline_at,
            plan_only, never_wait
          ) values (
            ${workflowId}, ${auth.organizationId}, ${branchThreadId}, ${runId}, ${rootBot.id}, ${auth.userId},
            'dm', 'queued', 1, ${policy.enabled}, ${policy.maxDepth}, ${maxSteps}, ${maxHandoffs},
            ${policy.timeoutSeconds}, ${policy.tokenBudget}, 1, ${usedHandoffs}, 0,
            now() + (${policy.timeoutSeconds} * interval '1 second'),
            ${source.planOnly === true}, ${source.neverWait === true}
          )
        `;
        await tx`
          insert into runs (
            id, organization_id, thread_id, bot_id, input, status, workflow_id,
            step_index, step_kind, stack_depth, caller_bot_id, execution_session_key,
            external_state, events_complete, plan_only
          ) values (
            ${runId}, ${auth.organizationId}, ${branchThreadId}, ${runBotId}, ${runInput}, 'queued',
            ${workflowId}, 0, ${stepKind}, ${stackDepth}, ${callerBotId}, ${executionSessionKey},
            'not_started', true, ${source.planOnly === true}
          )
        `;
        await tx`
          insert into messages (id, organization_id, thread_id, run_id, role, content)
          values (
            ${branchMessageId}, ${auth.organizationId}, ${branchThreadId}, ${runId}, 'user',
            ${versionDisplayContent(input, source.content)}
          )
        `;
        if (mention) {
          await tx`select pg_advisory_xact_lock(hashtext(${auth.organizationId}), hashtext('ohb-run-events-cursor'))`;
          await tx`
            insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at)
            values (${auth.organizationId}, ${branchThreadId}, ${runId}, 0, 'system.notice',
                    ${{
                      message: handoffSentNotice(mention),
                      kind: HANDOFF_NOTICE_KIND.sent,
                      targetBotId: mention.botId,
                    }}, now())
          `;
        }
        await tx`
          insert into message_versions (
            id, organization_id, root_thread_id, root_message_id, parent_thread_id, parent_message_id,
            branch_thread_id, branch_message_id, run_id, workflow_id, created_by_user_id,
            idempotency_key, request_hash, kind, ordinal, source_sequence, copied_message_count, prefix_truncated
          ) values (
            ${versionId}, ${auth.organizationId}, ${rootThreadId}, ${rootMessageId},
            ${source.threadId}, ${source.messageId}, ${branchThreadId}, ${branchMessageId},
            ${runId}, ${workflowId}, ${auth.userId}, ${key}, ${requestHash}, ${body.mode}, ${ordinal},
            ${source.sequence}, ${copied.length}, ${prefixTruncated}
          )
        `;
        const row = await readVersionByKey(tx, auth.organizationId, auth.userId, key);
        if (!row) throw new HttpError(500, "MESSAGE_VERSION_CREATE_FAILED", "La variante n’a pas été relue.");
        return { row: { ...row, workflowUpdatedAt }, duplicate: false };
      });
      if (created.duplicate) context.header("Idempotency-Replayed", "true");
      return context.json(
        publicCreated(created.row, sourceThreadId, sourceMessageId, created.duplicate),
        created.duplicate ? 200 : 201,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "MESSAGE_VERSION_CONFLICT", "Une autre variante a été créée. Actualisez puis réessayez.");
      }
      throw error;
    }
  });

  return routes;
}

function readCreateInput(body: Record<string, unknown>): CreateMessageVersionInput {
  if (body.mode !== "edit" && body.mode !== "regenerate") {
    throw new HttpError(400, "MESSAGE_VERSION_MODE_INVALID", "Le mode doit être edit ou regenerate.");
  }
  if (!Number.isSafeInteger(body.expectedVersionCount) || Number(body.expectedVersionCount) < 1) {
    throw new HttpError(400, "MESSAGE_VERSION_PRECONDITION_REQUIRED", "Le nombre de versions attendu est requis.");
  }
  if (body.mode === "regenerate" && body.input !== undefined) {
    throw new HttpError(400, "MESSAGE_VERSION_INPUT_UNEXPECTED", "Une régénération réutilise le message source.");
  }
  return {
    mode: body.mode,
    ...(body.mode === "edit" ? { input: assertString(body.input, "Le message modifié", { max: MAX_INPUT_CHARS }) } : {}),
    expectedVersionCount: Number(body.expectedVersionCount),
  };
}

export function versionRequestHash(
  sourceThreadId: string,
  sourceMessageId: string,
  body: CreateMessageVersionInput,
): string {
  return createHash("sha256").update(JSON.stringify({
    operation: OPERATION,
    sourceThreadId,
    sourceMessageId,
    mode: body.mode,
    input: body.mode === "edit" ? body.input?.trim() ?? "" : null,
    expectedVersionCount: body.expectedVersionCount,
  })).digest("hex");
}

async function assertPveReady(
  db: Db,
  config: ApiConfig,
  organizationId: string,
  dependencies: { readRuntime?: RuntimeReader; clientFactory?: (clientConfig: HermesClientConfig) => ToolsetClient },
): Promise<void> {
  const runtime = await (dependencies.readRuntime ?? readRuntimeSecret)(db, config, organizationId);
  if (!runtime) throw new HttpError(409, "RUNTIME_REQUIRED", "Aucun runtime Hermes actif n’est configuré.");
  try {
    const client = (dependencies.clientFactory ?? ((clientConfig) => new HermesClient(clientConfig)))(runtime.client);
    const violation = runtimeToolsetContractViolation(await client.toolsets());
    if (violation) throw new HttpError(409, violation.code, runtimeToolsetContractMessage(violation));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "RUNTIME_UNREACHABLE", "Le runtime Hermes n’est pas joignable.");
  }
}

async function assertThreadIdle(tx: TransactionDb, organizationId: string, threadId: string): Promise<void> {
  const rows = await tx<Array<{ activeRun: boolean; pendingApproval: boolean }>>`
    select exists(
             select 1 from runs where organization_id = ${organizationId} and thread_id = ${threadId}
               and status in ${tx(ACTIVE_RUN_STATUSES)}
           ) as "activeRun",
           exists(
             select 1 from approval_requests where organization_id = ${organizationId} and thread_id = ${threadId}
               and status = 'pending'
           ) as "pendingApproval"
  `;
  if (rows[0]?.pendingApproval) {
    throw new HttpError(409, "MESSAGE_VERSION_APPROVAL_PENDING", "Répondez à l’autorisation en attente avant de créer une variante.");
  }
  if (rows[0]?.activeRun) {
    throw new HttpError(409, "MESSAGE_VERSION_RUN_ACTIVE", "Arrêtez ou terminez le run actif avant de créer une variante.");
  }
}

function messageText(content: MessageContent): string {
  return content.filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text).join("").trim();
}

async function readSourceAncestry(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
  messageId: string,
): Promise<Pick<VersionRow, "rootThreadId" | "rootMessageId"> | null> {
  const rows = await tx<Array<Pick<VersionRow, "rootThreadId" | "rootMessageId">>>`
    select root_thread_id as "rootThreadId", root_message_id as "rootMessageId"
      from message_versions
     where organization_id = ${organizationId} and branch_thread_id = ${threadId}
       and branch_message_id = ${messageId}
  `;
  return rows[0] ?? null;
}

async function readVersionByKey(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  key: string,
): Promise<(VersionRow & { requestHash: string; workflowUpdatedAt: string | Date }) | null> {
  const rows = await tx<Array<VersionRow & { requestHash: string; workflowUpdatedAt: Date | string }>>`
    select version.root_thread_id as "rootThreadId", version.root_message_id as "rootMessageId",
           version.parent_thread_id as "parentThreadId", version.parent_message_id as "parentMessageId",
           version.branch_thread_id as "branchThreadId", version.branch_message_id as "branchMessageId",
           version.run_id as "runId", version.workflow_id as "workflowId", version.kind,
           version.ordinal, version.request_hash as "requestHash", workflow.updated_at as "workflowUpdatedAt",
           workflow.autonomy_enabled as "autonomyEnabled"
      from message_versions version
      join workflows workflow on workflow.organization_id = version.organization_id and workflow.id = version.workflow_id
     where version.organization_id = ${organizationId} and version.created_by_user_id = ${userId}
       and version.idempotency_key = ${key}
  `;
  return rows[0] ?? null;
}

async function loadSourceAttachments(
  tx: TransactionDb,
  blobs: BlobStore,
  organizationId: string,
  content: MessageContent,
): Promise<MessageAttachmentInput[]> {
  const parts = content.filter((part): part is Extract<MessageContent[number], { type: "attachment" }> =>
    part.type === "attachment");
  if (!parts.length) return [];
  if (parts.some((part) => !part.id)) {
    throw new HttpError(
      409,
      "MESSAGE_VERSION_ATTACHMENT_UNAVAILABLE",
      "Une pièce jointe historique n’a plus de fichier relisible; la variante n’a pas été créée.",
    );
  }
  const ids = parts.map((part) => part.id!);
  const rows = await tx<Array<{
    id: string;
    objectKey: string;
    name: string;
    contentType: string;
    kind: "image" | "document";
  }>>`
    select id, object_key as "objectKey", name, content_type as "contentType", kind
      from attachments
     where organization_id = ${organizationId} and id in ${tx(ids)} and deleted_at is null
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== ids.length) {
    throw new HttpError(
      409,
      "MESSAGE_VERSION_ATTACHMENT_UNAVAILABLE",
      "Une pièce jointe du message n’est plus disponible; la variante n’a pas été créée.",
    );
  }
  try {
    return await Promise.all(parts.map(async (part) => {
      const row = byId.get(part.id!)!;
      const blob = await blobs.get(row.objectKey);
      if (row.kind === "document") {
        return documentAttachment(row.name, row.contentType, await blob.text());
      }
      const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
      return imageAttachment(row.name, row.contentType, `data:${row.contentType};base64,${base64}`);
    }));
  } catch {
    throw new HttpError(
      409,
      "MESSAGE_VERSION_ATTACHMENT_UNAVAILABLE",
      "Une pièce jointe du message ne peut pas être relue; la variante n’a pas été créée.",
    );
  }
}

function versionDisplayContent(text: string, source: MessageContent): MessageContent {
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...source.filter((part): part is Extract<MessageContent[number], { type: "attachment" }> =>
      part.type === "attachment"),
  ];
}

function publicHistoryContent(content: MessageContent, _role: "user" | "assistant"): MessageContent {
  return content.flatMap((part): MessageContent => {
    if (part.type === "attachment") return [part];
    if (part.type !== "text") return [];
    const text = part.text;
    return text ? [{ type: "text", text }] : [];
  });
}

function assertSameRequest(savedHash: string, requestHash: string): void {
  if (savedHash !== requestHash) {
    throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé a déjà créé une autre variante.");
  }
}

function publicCreated(
  row: VersionRow & { workflowUpdatedAt?: string | Date },
  sourceThreadId: string,
  sourceMessageId: string,
  duplicate: boolean,
): MessageVersionCreatedDto {
  return {
    accepted: true,
    duplicate,
    mode: row.kind,
    rootThreadId: row.rootThreadId,
    rootMessageId: row.rootMessageId,
    sourceThreadId,
    sourceMessageId,
    branchThreadId: row.branchThreadId,
    branchMessageId: row.branchMessageId,
    runId: row.runId,
    workflowId: row.workflowId,
    ordinal: Number(row.ordinal),
    status: "queued",
    notificationEligible: workflowNotificationEligible({
      kind: "dm",
      autonomyEnabled: row.autonomyEnabled === true,
    }),
    workflowUpdatedAt: new Date(row.workflowUpdatedAt ?? Date.now()).toISOString(),
  };
}

async function readVersionFamilies(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
): Promise<MessageVersionFamilyDto[]> {
  const rows = await tx<Array<VersionRow>>`
    with relevant_roots as (
      select root_thread_id, root_message_id from message_versions
       where organization_id = ${organizationId} and branch_thread_id = ${threadId}
      union
      select root_thread_id, root_message_id from message_versions
       where organization_id = ${organizationId} and root_thread_id = ${threadId}
    )
    select version.root_thread_id as "rootThreadId", version.root_message_id as "rootMessageId",
           version.parent_thread_id as "parentThreadId", version.parent_message_id as "parentMessageId",
           version.branch_thread_id as "branchThreadId", version.branch_message_id as "branchMessageId",
           version.run_id as "runId", version.workflow_id as "workflowId", version.kind, version.ordinal
      from message_versions version
      join relevant_roots root on root.root_thread_id = version.root_thread_id
        and root.root_message_id = version.root_message_id
     where version.organization_id = ${organizationId}
     order by version.root_thread_id, version.root_message_id, version.ordinal
  `;
  const grouped = new Map<string, VersionRow[]>();
  for (const row of rows) {
    const key = `${row.rootThreadId}:${row.rootMessageId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return [...grouped.values()].flatMap((family) => {
    const first = family[0];
    if (!first) return [];
    const current = threadId === first.rootThreadId
      ? { threadId: first.rootThreadId, messageId: first.rootMessageId }
      : family.find((row) => row.branchThreadId === threadId)
        ? { threadId, messageId: family.find((row) => row.branchThreadId === threadId)!.branchMessageId }
        : null;
    if (!current) return [];
    const versions: MessageVersionLinkDto[] = [
      { threadId: first.rootThreadId, messageId: first.rootMessageId, ordinal: 0, kind: "original" },
      ...family.map((row) => ({
        threadId: row.branchThreadId,
        messageId: row.branchMessageId,
        ordinal: Number(row.ordinal),
        kind: row.kind,
      })),
    ];
    return [{
      rootThreadId: first.rootThreadId,
      rootMessageId: first.rootMessageId,
      currentThreadId: current.threadId,
      currentMessageId: current.messageId,
      versions,
    }];
  });
}
