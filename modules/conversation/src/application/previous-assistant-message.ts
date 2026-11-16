import type { TransactionDb } from "@openedbot/platform-db";

/**
 * The text of the assistant message just before a run's user message in its
 * thread (the message linked to the run, or the one a retry points to), or
 * null when there is none. With no user message found, the latest assistant
 * message of the thread from another run.
 */
export async function readPreviousAssistantText(
  tx: TransactionDb,
  organizationId: string,
  input: { threadId: string; runId: string; sourceMessageId: string | null },
): Promise<string | null> {
  const rows = await tx<Array<{ content: unknown }>>`
    select a.content from messages a
     where a.organization_id = ${organizationId} and a.thread_id = ${input.threadId} and a.role = 'assistant'
       and a.run_id is distinct from ${input.runId}::uuid
       and a.sequence < coalesce((
         select min(u.sequence) from messages u
          where u.organization_id = ${organizationId} and u.thread_id = ${input.threadId} and u.role = 'user'
            and (u.run_id = ${input.runId}::uuid or u.id = ${input.sourceMessageId}::uuid)
       ), 9223372036854775807)
     order by a.sequence desc
     limit 1
  `;
  const content = rows[0]?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part): part is { type: "text"; text: unknown } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n")
    .trim();
  return text || null;
}
