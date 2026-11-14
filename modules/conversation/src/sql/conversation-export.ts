import type { TransactionDb } from "@openedbot/platform-db";
import type { MessageContent } from "@openedbot/contracts-api";
export function readExportThread(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
) {
  return tx<
    Array<{
      id: string;
      title: string;
      botId: string | null;
      groupId: string | null;
    }>
  >`select id,title,bot_id as "botId",group_id as "groupId"
    from threads where organization_id=${organizationId} and id=${threadId}`;
}
export function readExportMessagePage(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
  sequence: string,
) {
  return tx<
    Array<{
      sequence: string;
      role: string;
      author: string | null;
      createdAt: Date | string;
      content: MessageContent;
    }>
  >`
    select sequence::text,role,original_author_name as author,created_at as "createdAt",content from messages
    where organization_id=${organizationId} and thread_id=${threadId} and sequence>${sequence}::bigint order by sequence limit 200`;
}
