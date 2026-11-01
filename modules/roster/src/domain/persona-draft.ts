/** Tours relus pour proposer un brouillon de persona. */
export const PERSONA_DRAFT_HISTORY = 12;

export function personaDraftSessionKey(organizationId: string, botId: string): string {
  return `ohb:${organizationId}:persona-draft:bot:${botId}`;
}

export function personaDraftCreateSessionKey(organizationId: string, threadId: string): string {
  return `ohb:${organizationId}:persona-draft:${threadId}`;
}

export function buildPersonaDraftInstructions(name: string): string {
  return [
    "## Persona draft",
    "",
    `Propose a revised persona for the bot named ${name}, based on the conversation transcript in the user message.`,
    "",
    "Rules:",
    "- Output the persona as markdown only: a `# Title`, `**Role:**`, `**Mission:**`, then short operating rules.",
    "- Do not invent capabilities the platform does not have.",
    "- Do not wrap the draft in a fence or commentary.",
    "- This draft is a proposal. It is not saved unless the operator confirms it.",
  ].join("\n");
}

export function formatPersonaDraftTranscript(
  messages: readonly { role: string; text: string }[],
): string {
  if (messages.length === 0) return "No messages.";
  return messages
    .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.text}`)
    .join("\n\n");
}
