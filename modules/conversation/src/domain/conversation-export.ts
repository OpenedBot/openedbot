import type { MessageContent } from "@openedbot/contracts-api";

/** Only persisted message content is exported, never run prompts, tool secrets or raw events. */
export function exportMessageMarkdown(message: {
  role: string;
  author: string | null;
  createdAt: Date | string;
  content: MessageContent;
}): string {
  const author = (message.author || message.role).replace(/[\r\n#]/g, " ");
  const parts = message.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "attachment")
        return `Attachment: ${part.name.replace(/[\r\n]/g, " ")} (id: ${part.id})`;
      return "";
    })
    .filter(Boolean);
  return `## ${author} — ${new Date(message.createdAt).toISOString()}\n\n${parts.join("\n\n")}\n\n`;
}
export const MAX_CONVERSATION_EXPORT_BYTES = 32 * 1024 * 1024;
