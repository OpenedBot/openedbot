import type { WebhookDeliveryReceiptDto } from "@openedbot/contracts-api";
import type { TransactionDb } from "@openedbot/platform-db";
import { HttpError } from "../../interfaces/http/http-error";
import { subscriptionPort } from "@openedbot/platform-db/subscription-port";

/**
 * Every statement of the webhook contexts (`webhook_endpoints`,
 * `webhook_deliveries`, `webhook_management_operations`), shared by the
 * ingress (`webhook-ingress-routes.ts`) and the management
 * (`webhook-management-routes.ts`) routers. `db/ownership.json` names the
 * owner `webhooks`: a context served by the API that has no module yet. The
 * statements the ingress runs on other tables (`subscriptions`,
 * `tenant_deletions`, `bots`, `workflows`, `runs`, `messages`...) are the
 * reads and writes of one accepted delivery.
 */

export type EndpointRow = {
  id: string;
  threadId: string;
  botId: string | null;
  groupId: string | null;
  createdByUserId: string | null;
  name: string;
  instructions: string;
  secretHash: string;
  enabled: boolean;
  deliveryCount: string | number;
  lastReceivedAt: Date | string | null;
  rotatedAt: Date | string;
  deletedAt: Date | string | null;
  createdAt: Date | string;
};

export type DeliveryRow = {
  id: string;
  endpointId: string;
  idempotencyKey: string;
  requestHash: string;
  state: "reserved" | "accepted";
  eventName: string | null;
  runId: string | null;
  workflowId: string | null;
  workflowStatus: WebhookDeliveryReceiptDto["workflowStatus"];
  errorCode: string | null;
  receivedAt: Date | string;
  acceptedAt: Date | string | null;
};

export type ManagementOperation = "webhook.create" | "webhook.rotate";

export type ManagementOperationRow = {
  endpointId: string;
  requestHash: string;
  secretCiphertext: string | null;
  secretNonce: string | null;
  secretTag: string | null;
  secretKeyId: string | null;
  recoverableUntil: Date | string;
};

export type BotPolicyRow = {
  id: string;
  autonomyEnabled: boolean;
  autonomyMaxDepth: number;
  autonomyMaxSteps: number;
  autonomyMaxHandoffs: number;
  autonomyTimeoutSeconds: number;
  autonomyTokenBudget: number;
};

export type RunnableThread = {
  id: string;
  botId: string | null;
  groupId: string | null;
  groupDefaultResponder: unknown;
  groupAnswerMode: string | null;
};

// --- Endpoints -------------------------------------------------------------

export async function readEndpointRows(
  tx: TransactionDb,
  organizationId: string,
  endpointId: string,
  lock: boolean,
): Promise<EndpointRow[]> {
  return tx<EndpointRow[]>`
    select e.id, e.thread_id as "threadId", t.bot_id as "botId", t.group_id as "groupId",
           e.created_by_user_id as "createdByUserId", e.name, e.instructions,
           e.secret_hash as "secretHash", e.enabled, e.delivery_count as "deliveryCount",
           e.last_received_at as "lastReceivedAt", e.rotated_at as "rotatedAt",
           e.deleted_at as "deletedAt", e.created_at as "createdAt"
      from webhook_endpoints e
      join threads t on t.organization_id = e.organization_id and t.id = e.thread_id
     where e.organization_id = ${organizationId} and e.id = ${endpointId}
     ${lock ? tx`for update of e, t` : tx``}
  `;
}

export async function readEndpoints(tx: TransactionDb, organizationId: string, threadId: string): Promise<EndpointRow[]> {
  return tx<EndpointRow[]>`
    select e.id, e.thread_id as "threadId", t.bot_id as "botId", t.group_id as "groupId",
           e.created_by_user_id as "createdByUserId", e.name, e.instructions, e.secret_hash as "secretHash",
           e.enabled, e.delivery_count as "deliveryCount", e.last_received_at as "lastReceivedAt",
           e.rotated_at as "rotatedAt", e.deleted_at as "deletedAt", e.created_at as "createdAt"
      from webhook_endpoints e join threads t on t.organization_id = e.organization_id and t.id = e.thread_id
     where e.organization_id = ${organizationId} and e.thread_id = ${threadId}
     order by e.created_at desc, e.id desc
  `;
}

export async function readEndpointById(
  tx: TransactionDb,
  organizationId: string,
  endpointId: string,
): Promise<EndpointRow | null> {
  const rows = await tx<EndpointRow[]>`
    select e.id, e.thread_id as "threadId", t.bot_id as "botId", t.group_id as "groupId",
           e.created_by_user_id as "createdByUserId", e.name, e.instructions, e.secret_hash as "secretHash",
           e.enabled, e.delivery_count as "deliveryCount", e.last_received_at as "lastReceivedAt",
           e.rotated_at as "rotatedAt", e.deleted_at as "deletedAt", e.created_at as "createdAt"
     from webhook_endpoints e join threads t on t.organization_id = e.organization_id and t.id = e.thread_id
     where e.organization_id = ${organizationId} and e.id = ${endpointId}
     for update of e
  `;
  return rows[0] ?? null;
}

/** Serializes the quota check of an organization's endpoint creations. */
export async function lockEndpointQuota(tx: TransactionDb, organizationId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${organizationId}), hashtext('openedbot-webhook-endpoint-quota'))`;
}

export async function countLiveEndpoints(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
): Promise<{ organizationCount: number; threadCount: number }> {
  const counts = await tx<Array<{ organizationCount: string | number; threadCount: string | number }>>`
    select count(*) as "organizationCount",
           count(*) filter (where thread_id = ${threadId}) as "threadCount"
      from webhook_endpoints where organization_id = ${organizationId} and deleted_at is null
  `;
  return {
    organizationCount: Number(counts[0]?.organizationCount ?? 0),
    threadCount: Number(counts[0]?.threadCount ?? 0),
  };
}

export async function insertEndpoint(
  tx: TransactionDb,
  endpoint: {
    id: string;
    organizationId: string;
    threadId: string;
    createdByUserId: string;
    name: string;
    instructions: string;
    secretHash: string;
  },
): Promise<EndpointRow> {
  const rows = await tx<EndpointRow[]>`
    insert into webhook_endpoints (
      id, organization_id, thread_id, created_by_user_id, name, instructions, secret_hash
    ) values (${endpoint.id}, ${endpoint.organizationId}, ${endpoint.threadId}, ${endpoint.createdByUserId}, ${endpoint.name}, ${endpoint.instructions}, ${endpoint.secretHash})
    returning id, thread_id as "threadId", null::uuid as "botId", null::uuid as "groupId",
              created_by_user_id as "createdByUserId", name, instructions, secret_hash as "secretHash",
              enabled, delivery_count as "deliveryCount", last_received_at as "lastReceivedAt",
              rotated_at as "rotatedAt", deleted_at as "deletedAt", created_at as "createdAt"
  `;
  return rows[0]!;
}

/** The row without its thread target (`botId`, `groupId`): the caller adds it. */
type UpdatedEndpointRow = Omit<EndpointRow, "botId" | "groupId">;

export async function updateEndpoint(
  tx: TransactionDb,
  organizationId: string,
  endpointId: string,
  changes: { name: string | null; instructions: string | null; enabled: boolean | null },
): Promise<UpdatedEndpointRow | null> {
  const { name, instructions, enabled } = changes;
  const rows = await tx<UpdatedEndpointRow[]>`
    update webhook_endpoints set
      name = coalesce(${name}, name), instructions = coalesce(${instructions}, instructions),
      enabled = coalesce(${enabled}, enabled), updated_at = now()
     where organization_id = ${organizationId} and id = ${endpointId} and deleted_at is null
    returning id, thread_id as "threadId", created_by_user_id as "createdByUserId", name, instructions,
              secret_hash as "secretHash", enabled, delivery_count as "deliveryCount",
              last_received_at as "lastReceivedAt", rotated_at as "rotatedAt",
              deleted_at as "deletedAt", created_at as "createdAt"
  `;
  return rows[0] ?? null;
}

export async function rotateEndpointSecret(
  tx: TransactionDb,
  organizationId: string,
  endpointId: string,
  secretHash: string,
): Promise<UpdatedEndpointRow | null> {
  const rows = await tx<UpdatedEndpointRow[]>`
    update webhook_endpoints set secret_hash = ${secretHash}, rotated_at = now(), updated_at = now()
     where organization_id = ${organizationId} and id = ${endpointId} and deleted_at is null
    returning id, thread_id as "threadId", created_by_user_id as "createdByUserId", name, instructions,
              secret_hash as "secretHash", enabled, delivery_count as "deliveryCount",
              last_received_at as "lastReceivedAt", rotated_at as "rotatedAt",
              deleted_at as "deletedAt", created_at as "createdAt"
  `;
  return rows[0] ?? null;
}

/** Disables the endpoint and replaces its secret with an unguessable tombstone; `false` when unknown. */
export async function tombstoneEndpoint(
  tx: TransactionDb,
  organizationId: string,
  endpointId: string,
  tombstoneHash: string,
): Promise<boolean> {
  const rows = await tx<Array<{ id: string }>>`
    update webhook_endpoints set enabled = false, secret_hash = ${tombstoneHash},
           deleted_at = coalesce(deleted_at, now()), updated_at = now()
     where organization_id = ${organizationId} and id = ${endpointId}
    returning id
  `;
  return rows[0] !== undefined;
}

export async function recordEndpointDelivery(tx: TransactionDb, organizationId: string, endpointId: string): Promise<void> {
  await tx`
    update webhook_endpoints set delivery_count = delivery_count + 1,
           last_received_at = now(), updated_at = now()
     where organization_id = ${organizationId} and id = ${endpointId}
  `;
}

// --- Deliveries ------------------------------------------------------------

export async function readDeliveryReceipts(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
): Promise<DeliveryRow[]> {
  return tx<DeliveryRow[]>`
    select d.id, d.endpoint_id as "endpointId", d.idempotency_key as "idempotencyKey",
           d.request_hash as "requestHash", d.state, d.event_name as "eventName",
           d.run_id as "runId", d.workflow_id as "workflowId",
           w.status as "workflowStatus", w.error_code as "errorCode",
           d.received_at as "receivedAt", d.accepted_at as "acceptedAt"
      from webhook_deliveries d
      left join workflows w on w.organization_id = d.organization_id and w.id = d.workflow_id
     where d.organization_id = ${organizationId} and d.thread_id = ${threadId}
     order by d.received_at desc, d.id desc limit 50
  `;
}

export async function readDelivery(
  tx: TransactionDb,
  organizationId: string,
  endpointId: string,
  key: string,
  lock: boolean,
): Promise<DeliveryRow | null> {
  const rows = await tx<DeliveryRow[]>`
    select d.id, d.endpoint_id as "endpointId", d.idempotency_key as "idempotencyKey",
           d.request_hash as "requestHash", d.state, d.event_name as "eventName",
           d.run_id as "runId", d.workflow_id as "workflowId", w.status as "workflowStatus",
           w.error_code as "errorCode", d.received_at as "receivedAt", d.accepted_at as "acceptedAt"
      from webhook_deliveries d
      left join workflows w on w.organization_id = d.organization_id and w.id = d.workflow_id
     where d.organization_id = ${organizationId} and d.endpoint_id = ${endpointId} and d.idempotency_key = ${key}
     ${lock ? tx`for update of d` : tx``}
  `;
  return rows[0] ?? null;
}

/** Claims the idempotency key; `false` when another delivery already holds it. */
export async function reserveDelivery(
  tx: TransactionDb,
  delivery: {
    id: string;
    organizationId: string;
    endpointId: string;
    threadId: string;
    idempotencyKey: string;
    requestHash: string;
    eventName: string | null;
  },
): Promise<boolean> {
  const reserved = await tx<Array<{ id: string }>>`
    insert into webhook_deliveries (
      id, organization_id, endpoint_id, thread_id, idempotency_key,
      request_hash, state, event_name
    ) values (
      ${delivery.id}, ${delivery.organizationId}, ${delivery.endpointId}, ${delivery.threadId}, ${delivery.idempotencyKey},
      ${delivery.requestHash}, 'reserved', ${delivery.eventName}
    ) on conflict (organization_id, endpoint_id, idempotency_key) do nothing returning id
  `;
  return reserved[0] !== undefined;
}

export async function countRecentAcceptedDeliveries(
  tx: TransactionDb,
  organizationId: string,
  endpointId: string,
): Promise<number> {
  const recent = await tx<Array<{ count: string | number }>>`
    select count(*) as count from webhook_deliveries
     where organization_id = ${organizationId} and endpoint_id = ${endpointId}
       and state = 'accepted' and received_at >= now() - interval '1 minute'
  `;
  return Number(recent[0]?.count ?? 0);
}

export async function markDeliveryAccepted(
  tx: TransactionDb,
  accepted: { organizationId: string; deliveryId: string; messageId: string; runId: string; workflowId: string },
): Promise<void> {
  await tx`
    update webhook_deliveries set state = 'accepted', message_id = ${accepted.messageId}, run_id = ${accepted.runId},
           workflow_id = ${accepted.workflowId}, accepted_at = now()
     where organization_id = ${accepted.organizationId} and id = ${accepted.deliveryId} and state = 'reserved'
  `;
}

// --- Management operations (idempotent create / rotate) --------------------

/**
 * Serializes one idempotency key, and drops the encrypted secret of this
 * organization's operations once their recovery window has passed. The
 * idempotency tombstone stays; the secret does not.
 */
export async function lockManagementOperation(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  operation: ManagementOperation,
  key: string,
): Promise<void> {
  await tx`
    select pg_advisory_xact_lock(
      hashtext(${`${organizationId}:${userId}`}),
      hashtext(${`${operation}:${key}`})
    )
  `;
  // On conserve le tombstone d'idempotence, mais plus le secret chiffré une
  // fois sa fenêtre de récupération passée.
  await tx`
    update webhook_management_operations
       set secret_ciphertext = null, secret_nonce = null, secret_tag = null, secret_key_id = null
     where organization_id = ${organizationId} and recoverable_until <= now()
       and secret_ciphertext is not null
  `;
}

export async function readManagementOperation(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  operation: ManagementOperation,
  key: string,
): Promise<ManagementOperationRow | null> {
  const rows = await tx<ManagementOperationRow[]>`
    select endpoint_id as "endpointId", request_hash as "requestHash",
           secret_ciphertext as "secretCiphertext", secret_nonce as "secretNonce",
           secret_tag as "secretTag", secret_key_id as "secretKeyId",
           recoverable_until as "recoverableUntil"
      from webhook_management_operations
     where organization_id = ${organizationId} and user_id = ${userId}
       and operation = ${operation} and idempotency_key = ${key}
     for update
  `;
  return rows[0] ?? null;
}

export async function insertManagementOperation(
  tx: TransactionDb,
  operation: {
    organizationId: string;
    userId: string;
    endpointId: string;
    operation: ManagementOperation;
    idempotencyKey: string;
    requestHash: string;
    secretCiphertext: string;
    secretNonce: string;
    secretTag: string;
    secretKeyId: string;
    recoverableHours: number;
  },
): Promise<void> {
  await tx`
    insert into webhook_management_operations (
      id, organization_id, user_id, endpoint_id, operation, idempotency_key, request_hash,
      secret_ciphertext, secret_nonce, secret_tag, secret_key_id, recoverable_until
    ) values (
      ${crypto.randomUUID()}, ${operation.organizationId}, ${operation.userId}, ${operation.endpointId}, ${operation.operation}, ${operation.idempotencyKey}, ${operation.requestHash},
      ${operation.secretCiphertext}, ${operation.secretNonce}, ${operation.secretTag}, ${operation.secretKeyId},
      now() + (${operation.recoverableHours} * interval '1 hour')
    )
  `;
}

// --- Threads ---------------------------------------------------------------

export async function requireThread(tx: TransactionDb, organizationId: string, threadId: string): Promise<void> {
  const rows = await tx<Array<{ id: string }>>`
    select id from threads where organization_id = ${organizationId} and id = ${threadId} for key share
  `;
  if (!rows[0]) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
}

export async function requireRunnableThread(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
  lock = false,
): Promise<RunnableThread> {
  const rows = await tx<RunnableThread[]>`
    select t.id, t.bot_id as "botId", t.group_id as "groupId",
           g.default_responder as "groupDefaultResponder", g.answer_mode as "groupAnswerMode"
      from threads t
      left join bot_groups g on g.organization_id = t.organization_id and g.id = t.group_id
     where t.organization_id = ${organizationId} and t.id = ${threadId}
      ${lock ? tx`for update of t` : tx`for key share of t`}
  `;
  const thread = rows[0];
  if (!thread) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
  if (thread.botId) {
    const bot = await tx<Array<{ id: string }>>`
      select id from bots where organization_id = ${organizationId} and id = ${thread.botId} and archived_at is null
    `;
    if (!bot[0]) throw new HttpError(409, "WORKFLOW_BOT_UNAVAILABLE", "Le bot cible est indisponible.");
  } else if (thread.groupId) {
    const member = await tx<Array<{ id: string }>>`
      select b.id from group_members gm join bots b on b.organization_id = gm.organization_id and b.id = gm.bot_id
       where gm.organization_id = ${organizationId} and gm.group_id = ${thread.groupId} and b.archived_at is null limit 1
    `;
    if (!member[0]) throw new HttpError(409, "GROUP_EMPTY", "Ce groupe n’a aucun membre actif.");
  }
  return thread;
}

export async function readThreadTarget(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
): Promise<{ botId: string | null; groupId: string | null }> {
  const rows = await tx<Array<{ botId: string | null; groupId: string | null }>>`
    select bot_id as "botId", group_id as "groupId" from threads
     where organization_id = ${organizationId} and id = ${threadId}
  `;
  if (!rows[0]) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
  return rows[0];
}

export async function touchThread(tx: TransactionDb, organizationId: string, threadId: string): Promise<void> {
  await tx`update threads set updated_at = now() where organization_id = ${organizationId} and id = ${threadId}`;
}

// --- What one accepted delivery reads and writes ---------------------------

export async function lockSubscriptionStatus(
  tx: TransactionDb,
  organizationId: string,
): Promise<{ status: string } | undefined> {
  const plan = await subscriptionPort().readForUpdate(tx, organizationId);
  return plan ? { status: plan.status } : undefined;
}

export async function hasPendingAccountDeletion(tx: TransactionDb, organizationId: string): Promise<boolean> {
  const deletion = (await tx<Array<{ pending: boolean }>>`
    select exists(select 1 from tenant_deletions where organization_id = ${organizationId}
      and reason = 'account_deleted') as pending
  `)[0];
  return Boolean(deletion?.pending);
}

export async function readActiveGroupMembers(
  tx: TransactionDb,
  organizationId: string,
  groupId: string,
): Promise<Array<{ id: string; slug: string; position: number }>> {
  return tx<Array<{ id: string; slug: string; position: number }>>`
    select b.id, b.slug, gm.position from group_members gm
      join bots b on b.organization_id = gm.organization_id and b.id = gm.bot_id
     where gm.organization_id = ${organizationId} and gm.group_id = ${groupId}
       and b.archived_at is null order by gm.position asc
  `;
}

/** The autonomy policy of the bot that will answer, locked until the delivery commits. */
export async function lockBotPolicy(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<BotPolicyRow | undefined> {
  const policyRows = await tx<BotPolicyRow[]>`
    select id, autonomy_enabled as "autonomyEnabled", autonomy_max_depth as "autonomyMaxDepth",
           autonomy_max_steps as "autonomyMaxSteps", autonomy_max_handoffs as "autonomyMaxHandoffs",
           autonomy_timeout_seconds as "autonomyTimeoutSeconds", autonomy_token_budget as "autonomyTokenBudget"
      from bots where organization_id = ${organizationId} and id = ${botId}
       and archived_at is null for update
  `;
  return policyRows[0];
}

export async function insertQueuedWorkflow(
  tx: TransactionDb,
  workflow: {
    id: string;
    organizationId: string;
    threadId: string;
    rootRunId: string;
    rootBotId: string;
    initiatorUserId: string | null;
    kind: "group" | "dm";
    autonomyEnabled: boolean;
    maxDepth: number;
    maxSteps: number;
    maxHandoffs: number;
    timeoutSeconds: number;
    tokenBudget: number;
  },
): Promise<void> {
  await tx`
    insert into workflows (
      id, organization_id, thread_id, root_run_id, root_bot_id, initiator_user_id,
      kind, status, protocol_version, autonomy_enabled, max_depth, max_steps, max_handoffs,
      timeout_seconds, token_budget, used_steps, used_handoffs, used_tokens, deadline_at
    ) values (
      ${workflow.id}, ${workflow.organizationId}, ${workflow.threadId}, ${workflow.rootRunId}, ${workflow.rootBotId}, ${workflow.initiatorUserId},
      ${workflow.kind}, 'queued', 1, ${workflow.autonomyEnabled}, ${workflow.maxDepth},
      ${workflow.maxSteps}, ${workflow.maxHandoffs}, ${workflow.timeoutSeconds}, ${workflow.tokenBudget},
      1, 0, 0, now() + (${workflow.timeoutSeconds} * interval '1 second')
    )
  `;
}

export async function insertQueuedRun(
  tx: TransactionDb,
  run: {
    id: string;
    organizationId: string;
    threadId: string;
    botId: string;
    groupTurnPosition: number | null;
    groupState: unknown;
    input: string;
    workflowId: string;
    stepKind: "group" | "root";
  },
): Promise<void> {
  await tx`
    insert into runs (
      id, organization_id, thread_id, bot_id, group_turn_position, group_state, input, status,
      workflow_id, step_index, step_kind, stack_depth, external_state, events_complete
    ) values (
      ${run.id}, ${run.organizationId}, ${run.threadId}, ${run.botId}, ${run.groupTurnPosition}, ${run.groupState}, ${run.input},
      'queued', ${run.workflowId}, 0, ${run.stepKind}, 0, 'not_started', true
    )
  `;
}

export async function insertUserMessage(
  tx: TransactionDb,
  message: { id: string; organizationId: string; threadId: string; runId: string; content: unknown },
): Promise<void> {
  await tx`
    insert into messages (id, organization_id, thread_id, run_id, role, content)
    values (${message.id}, ${message.organizationId}, ${message.threadId}, ${message.runId}, 'user', ${message.content})
  `;
}

export async function clearGroupNeedsYou(tx: TransactionDb, organizationId: string, groupId: string): Promise<void> {
  await tx`update bot_groups set needs_you = false, updated_at = now()
    where organization_id = ${organizationId} and id = ${groupId}`;
}
