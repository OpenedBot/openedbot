import type { TransactionDb } from "@openedbot/platform-db";
import type { ConversationFileDto } from "@openedbot/contracts-api";

export function listConversationFiles(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
  search: string,
  cursor: string | null,
) {
  return tx<
    ConversationFileDto[]
  >`select a.id,a.message_id as "messageId",a.name,a.content_type as "contentType",a.kind,a.bytes,
    a.created_at as "createdAt",m.role from attachments a join messages m on m.organization_id=a.organization_id and m.id=a.message_id
    where a.organization_id=${organizationId} and m.thread_id=${threadId} and a.deleted_at is null
      and position(lower(${search}) in lower(a.name))>0
      and (${cursor}::uuid is null or (a.created_at,a.id)<(select created_at,id from attachments where organization_id=${organizationId} and id=${cursor}::uuid))
    order by a.created_at desc,a.id desc limit 41`;
}

export async function conversationFileCursorExists(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
  cursor: string,
): Promise<boolean> {
  const rows =
    await tx`select a.id from attachments a join messages m on m.organization_id=a.organization_id and m.id=a.message_id
    where a.organization_id=${organizationId} and a.id=${cursor} and m.thread_id=${threadId}`;
  return rows.length > 0;
}
