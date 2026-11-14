import { Hono } from "hono";
import { MESSAGE_REACTION_EMOJIS } from "@openedbot/conversation/domain/message-reply";
import type { AppVariables } from "../identity/auth";
import type { BlobStore } from "../../infrastructure/blob-store";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import type { ApiConfig } from "../../infrastructure/config";
import { readIdempotencyKey, readMessageIngressStatus } from "@openedbot/conversation/application/message-ingress";
import { requestThreadCancellationTx } from "@openedbot/execution/application/run-cancellation";
import { conversationThreadRoutes } from "./conversation-thread-routes";
import { conversationMessageRoutes } from "./conversation-message-routes";
import { parseReadThrough, readMessageReaction } from "./conversation-input";
import { settleCancelledHandoffsTx } from "./conversation-followup";

export { MESSAGE_REACTION_EMOJIS };
export { approvalRoutes } from "./approval-routes";
export { attachmentDeliveryHeaders, attachmentRoutes, isHtmlAttachmentType } from "./attachment-routes";
export {
  activeRunSteerTargetTx,
  cancelledHandoffReply,
  followupDispositionTx,
  MAX_RUN_STEER_CHARS,
  type FollowupDisposition,
} from "./conversation-followup";
export {
  openGroupSend,
  parseReadThrough,
  readMessageReaction,
  readPlanOnly,
  readReplyToId,
  readThreadGroup,
} from "./conversation-input";
export { runRoutes } from "./run-routes";

export function conversationRoutes(db: Db, blobs: BlobStore, config: ApiConfig): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.route("/", conversationThreadRoutes(db));

  routes.post("/:threadId/read", async (context) => {
    const auth = context.get("auth");
    const body = await jsonBody(context.req.raw);
    const readThrough = parseReadThrough(body.readThrough);
    const rows = await withTenant(db, auth.organizationId, (tx) => tx<Array<{ threadId: string }>>`
      insert into thread_reads (organization_id, user_id, thread_id, read_at)
      select ${auth.organizationId}, ${auth.userId}, thread.id, ${readThrough}
        from threads thread
       where thread.organization_id = ${auth.organizationId}
         and thread.id = ${context.req.param("threadId")}
      on conflict (organization_id, user_id, thread_id) do update
        set read_at = greatest(thread_reads.read_at, excluded.read_at),
            updated_at = now()
      returning thread_id as "threadId"
    `);
    if (!rows[0]) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
    return context.body(null, 204);
  });

  routes.delete("/:threadId/read", async (context) => {
    const auth = context.get("auth");
    const rows = await withTenant(db, auth.organizationId, (tx) => tx<Array<{ threadId: string }>>`
      with target_thread as (
        select thread.id
          from threads thread
         where thread.organization_id = ${auth.organizationId}
           and thread.id = ${context.req.param("threadId")}
      ), removed as (
        delete from thread_reads reads
         using target_thread target
         where reads.organization_id = ${auth.organizationId}
           and reads.user_id = ${auth.userId}
           and reads.thread_id = target.id
      )
      select id as "threadId" from target_thread
    `);
    if (!rows[0]) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
    return context.body(null, 204);
  });

  /**
   * Removes a thread from the current user's roster, without changing the thread.
   * The INSERT starts from a tenant-scoped SELECT: an invented identifier or one taken
   * from another organization produces the same 404 and creates no state.
   */
  routes.put("/:threadId/hidden", async (context) => {
    const auth = context.get("auth");
    const rows = await withTenant(db, auth.organizationId, (tx) => tx<Array<{ threadId: string }>>`
      insert into thread_hides (organization_id, user_id, thread_id)
      select ${auth.organizationId}, ${auth.userId}, thread.id
        from threads thread
       where thread.organization_id = ${auth.organizationId}
         and thread.id = ${context.req.param("threadId")}
      on conflict (organization_id, user_id, thread_id) do update
        set hidden_at = thread_hides.hidden_at
      returning thread_id as "threadId"
    `);
    if (!rows[0]) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
    return context.body(null, 204);
  });

  /** Showing again is idempotent, but still requires that the thread exist here. */
  routes.delete("/:threadId/hidden", async (context) => {
    const auth = context.get("auth");
    const rows = await withTenant(db, auth.organizationId, (tx) => tx<Array<{ threadId: string }>>`
      with target_thread as (
        select thread.id
          from threads thread
         where thread.organization_id = ${auth.organizationId}
           and thread.id = ${context.req.param("threadId")}
      ), removed as (
        delete from thread_hides hidden
         using target_thread target
         where hidden.organization_id = ${auth.organizationId}
           and hidden.user_id = ${auth.userId}
           and hidden.thread_id = target.id
      )
      select id as "threadId" from target_thread
    `);
    if (!rows[0]) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
    return context.body(null, 204);
  });

  routes.put("/:threadId/messages/:messageId/reactions", async (context) => {
    const auth = context.get("auth");
    const emoji = readMessageReaction((await jsonBody(context.req.raw)).emoji);
    const rows = await withTenant(db, auth.organizationId, (tx) => tx<Array<{ messageId: string }>>`
      with target as (
        select message.id, message.thread_id
          from messages message
         where message.organization_id = ${auth.organizationId}
           and message.thread_id = ${context.req.param("threadId")}
           and message.id = ${context.req.param("messageId")}
      )
      insert into message_reactions (organization_id, thread_id, message_id, user_id, emoji)
      select ${auth.organizationId}, target.thread_id, target.id, ${auth.userId}, ${emoji}
        from target
      on conflict (organization_id, user_id, message_id, emoji) do update
        set updated_at = now()
      returning message_id as "messageId"
    `);
    if (!rows[0]) throw new HttpError(404, "MESSAGE_NOT_FOUND", "Message introuvable.");
    return context.body(null, 204);
  });

  routes.delete("/:threadId/messages/:messageId/reactions", async (context) => {
    const auth = context.get("auth");
    const emoji = readMessageReaction((await jsonBody(context.req.raw)).emoji);
    const rows = await withTenant(db, auth.organizationId, (tx) => tx<Array<{ messageId: string }>>`
      with target as (
        select message.id
          from messages message
         where message.organization_id = ${auth.organizationId}
           and message.thread_id = ${context.req.param("threadId")}
           and message.id = ${context.req.param("messageId")}
      ), removed as (
        delete from message_reactions reaction
         using target
         where reaction.organization_id = ${auth.organizationId}
           and reaction.user_id = ${auth.userId}
           and reaction.message_id = target.id
           and reaction.emoji = ${emoji}
      )
      select id as "messageId" from target
    `);
    if (!rows[0]) throw new HttpError(404, "MESSAGE_NOT_FOUND", "Message introuvable.");
    return context.body(null, 204);
  });

  routes.route("/", conversationMessageRoutes(db, blobs, config));

  routes.get("/:threadId/submissions/:key", async (context) => {
    const auth = context.get("auth");
    const key = readIdempotencyKey(context.req.param("key"));
    if (!key) throw new HttpError(400, "IDEMPOTENCY_KEY_INVALID", "La clé est requise.");
    return context.json(await readMessageIngressStatus({
      db,
      auth,
      threadId: context.req.param("threadId"),
      key,
    }));
  });

  routes.post("/:threadId/stop", async (context) => {
    const auth = context.get("auth");
    await withTenant(db, auth.organizationId, async (tx) => {
      const uncertain = await tx<Array<{ id: string }>>`
        select id from runs where organization_id = ${auth.organizationId}
          and thread_id = ${context.req.param("threadId")} and status = 'unknown'
         limit 1 for update
      `;
      if (uncertain[0]) {
        throw new HttpError(409, "WORKFLOW_REVIEW_REQUIRED", "Réconciliez ou abandonnez le workflow incertain.");
      }
      const cancelled = await requestThreadCancellationTx(
        tx,
        auth.organizationId,
        context.req.param("threadId"),
        { code: "CANCELLED_BY_USER", message: "Run annulé." },
      );
      await settleCancelledHandoffsTx(
        tx,
        auth.organizationId,
        cancelled.filter((run) => run.status === "cancelled"),
      );
    });
    return context.body(null, 204);
  });

  return routes;
}
