import type { SQL } from 'bun';
import type { ReplyPromptContext } from '../domain/message-reply';

export type ThreadReplyTarget = ReplyPromptContext & { organizationId: string; threadId: string };
export type ThreadAttachmentRow = { id: string; objectKey: string; name: string; contentType: string; kind: string; bytes: number };

/** Only explicit references within this tenant and thread may rehydrate old attachments. */
export async function readThreadReplyTargets(db: SQL, organizationId: string, threadId: string, ids: string[]): Promise<ThreadReplyTarget[]> {
  if (!ids.length) return [];
  return db<ThreadReplyTarget[]>`
    select reply.id, reply.organization_id as "organizationId", reply.thread_id as "threadId",
           reply.role, reply.content, reply.original_author_name as "authorName"
      from messages reply
     where reply.organization_id = ${organizationId} and reply.thread_id = ${threadId}
       and reply.id in ${db(ids)} and reply.role in ('user','assistant')`;
}

export async function readThreadAttachmentRows(db: SQL, organizationId: string, threadId: string, ids: string[]): Promise<ThreadAttachmentRow[]> {
  if (!ids.length) return [];
  return db<ThreadAttachmentRow[]>`
    select attachment.id, attachment.object_key as "objectKey", attachment.name,
           attachment.content_type as "contentType", attachment.kind, attachment.bytes
      from attachments attachment
      join messages owner on owner.id = attachment.message_id and owner.organization_id = attachment.organization_id
     where attachment.organization_id = ${organizationId} and owner.thread_id = ${threadId}
       and attachment.id in ${db(ids)} and attachment.deleted_at is null`;
}
