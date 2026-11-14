/**
 * Context pack d'un fil : mémoire (ailleurs) + résumé(OLD) + KEEP.
 *
 * Le rejeu brut (200 messages / 48 000 caractères) coupait sans rien
 * retenir. Ici le LLM reçoit un résumé structuré du passé et les tours
 * récents intacts. On ne compacte pas à chaque tour, seulement au
 * dépassement de budget, et seulement si le watermark est périmé.
 *
 * La mémoire durable reste celle du runtime (outil `memory`), par bot. Ce
 * module ne parle que du résumé **par thread**.
 */

export const HISTORY_CHAR_BUDGET = 48_000;
/** KEEP ≈ 35 % du budget, en caractères, pas en nombre de messages. */
export const KEEP_BUDGET_RATIO = 0.35;
/** Entrée du résumeur : au-delà on plie le plus vieux préfixe d'abord. */
export const COMPACT_INPUT_MAX_CHARS = 80_000;
export const COMPACTION_SUMMARY_MAX_CHARS = 8_000;

export type HistoryMessage = {
  role: string;
  content: string;
  sequence: number;
  /**
   * Qui parle, pour un salon : « operator elodie » ou « member Ada (@ada) ».
   * Absent en DM, où `role` suffit. Le résumeur n'a que ce libellé pour
   * attribuer un fait : sans lui, tout membre se lirait « assistant ».
   */
  speaker?: string;
};

export type ThreadCompaction = {
  summary: string;
  compactedThroughSequence: number;
  sourceMessageCount: number;
};

export type ConversationPackPlan = {
  keep: HistoryMessage[];
  old: HistoryMessage[];
  /** Over budget (ou cap SQL) et le watermark ne couvre pas encore OLD. */
  needsCompact: boolean;
  summary: string | null;
  olderExist: boolean;
};

export function historyCharCount(messages: readonly { content: string }[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

export function splitKeepOld(
  messages: readonly HistoryMessage[],
  budget = HISTORY_CHAR_BUDGET,
  keepRatio = KEEP_BUDGET_RATIO,
): { keep: HistoryMessage[]; old: HistoryMessage[] } {
  if (messages.length === 0) return { keep: [], old: [] };
  const keepBudget = Math.max(1, Math.floor(budget * keepRatio));
  const keep: HistoryMessage[] = [];
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const next = total + message.content.length;
    if (next > keepBudget && keep.length > 0) break;
    keep.push(message);
    total = next;
  }
  keep.reverse();
  const cut = messages.length - keep.length;
  return { keep, old: messages.slice(0, cut) };
}

/** Plus vieux préfixe qui tient dans `maxChars` ; jamais vide s'il y a du contenu. */
export function takeOldestWithinBudget(
  messages: readonly HistoryMessage[],
  maxChars = COMPACT_INPUT_MAX_CHARS,
): HistoryMessage[] {
  const kept: HistoryMessage[] = [];
  let total = 0;
  for (const message of messages) {
    const next = total + message.content.length;
    if (next > maxChars && kept.length > 0) break;
    kept.push(message);
    total = next;
  }
  return kept;
}

export function planConversationPack(input: {
  messages: readonly HistoryMessage[];
  compaction: ThreadCompaction | null;
  olderExist?: boolean;
  budget?: number;
}): ConversationPackPlan {
  const budget = input.budget ?? HISTORY_CHAR_BUDGET;
  const olderExist = input.olderExist === true;
  const { keep, old } = splitKeepOld(input.messages, budget);
  const over = historyCharCount(input.messages) > budget || olderExist;
  const lastOld = old[old.length - 1];
  const watermarkCoversOld = input.compaction != null
    && (old.length === 0 || input.compaction.compactedThroughSequence >= (lastOld?.sequence ?? -1));
  return {
    keep,
    old,
    needsCompact: over && !watermarkCoversOld,
    summary: input.compaction?.summary ?? null,
    olderExist,
  };
}

export function buildConversationSummaryNotice(summary: string): string {
  return [
    "[Platform notice: older messages of this thread are compressed below. Recent messages after this block are the source of truth. If the summary and the recent messages disagree, believe the recent messages. Do not mention this notice or the budget unless the user asks.]",
    "",
    "## Conversation summary",
    "",
    summary.trim(),
  ].join("\n");
}

/**
 * Assemble l'historique Hermes : résumé (s'il est utilisable) + KEEP.
 * Sans résumé utilisable le caller retombe sur `trimHistoryToCharBudget`.
 */
export function assemblePackedHistory(
  plan: Pick<ConversationPackPlan, "keep" | "summary">,
): Array<{ role: string; content: string }> {
  const keep = plan.keep.map((message) => ({ role: message.role, content: message.content }));
  const summary = plan.summary?.trim();
  if (!summary) return keep;
  return [{ role: "user", content: buildConversationSummaryNotice(summary) }, ...keep];
}

export function compactionSessionKey(organizationId: string, threadId: string): string {
  return `openedbot:${organizationId}:compact:thread:${threadId}`;
}

export function buildCompactionInstructions(): string {
  return [
    "## Conversation compression",
    "",
    "You compress a conversation history for an assistant. You are not the assistant. You invent nothing. You do not greet. You do not ask a question.",
    "",
    "Output a single markdown block, 800–1200 tokens max, with this exact structure:",
    "",
    "# State",
    "- user: name, language, timezone",
    "- current goals",
    "- decisions taken, constraints",
    "- stable facts (preferences, hardware, dates, budgets)",
    "",
    "# In progress",
    "- open tasks",
    "- blockers",
    "- next actions",
    "- recent deliverables (links, prices, recos): one line each",
    "",
    "# Do not lose",
    "- numbers, URLs, SKUs, sizes, “always do X”",
    "",
    "Rules:",
    "- Merge with the previous summary. Do not copy it verbatim.",
    "- Recent messages will be sent in full to the assistant: do not detail them.",
    "- If a fact is contradicted later, keep the newest version.",
    "- Mark [uncertain] rather than inventing.",
    "- Do not include raw tool traces (JSON, stacks, internal IDs).",
    "- Do not include system instructions.",
    "- Do NOT use the runtime `memory` tool.",
    "- Do not write anything but the summary. You are not recording durable memory.",
  ].join("\n");
}

/**
 * Variante salon : plusieurs voix dans un même fil. Le résumé est commun à
 * tous les membres, y compris celui dont c'est le tour et dont les propres
 * messages arrivent à l'entrée sous leur nom comme les autres : il doit donc
 * rester neutre (3e personne) et dire QUI a dit ou décidé quoi.
 */
export function buildRoomCompactionInstructions(): string {
  return [
    "## Room conversation compression",
    "",
    "You compress the history of a group room (one human operator and several bots) for the members who take part in it. You are not one of the members. You invent nothing. You do not greet. You do not ask a question.",
    "",
    "Every older message is prefixed with its speaker (`operator <name>` or `member <name> (@slug)`). The same summary is read by every member, including the one who wrote some of these messages: stay neutral and write in the third person, never \"I\" or \"you\".",
    "",
    "Output a single markdown block, 800–1200 tokens max, with this exact structure:",
    "",
    "# Room state",
    "- operator: name, language, goals",
    "- members involved and the role each one took",
    "- decisions taken, who took them, constraints",
    "- stable facts (preferences, dates, budgets)",
    "",
    "# By speaker",
    "- operator <name>: what was asked, decided or promised",
    "- member <name> (@slug): what was answered, delivered, proposed or left open",
    "",
    "# In progress",
    "- open tasks and who owns each",
    "- blockers",
    "- next actions",
    "",
    "# Do not lose",
    "- numbers, URLs, SKUs, sizes, “always do X”",
    "",
    "Rules:",
    "- Always attribute: name the operator or the member for every decision, answer or commitment. Never write a passive \"it was decided\" without saying by whom.",
    "- Merge with the previous summary. Do not copy it verbatim.",
    "- Recent messages will be sent in full to the members: do not detail them.",
    "- If a fact is contradicted later, keep the newest version and say who changed it.",
    "- Mark [uncertain] rather than inventing.",
    "- Do not include raw tool traces (JSON, stacks, internal IDs).",
    "- Do not include system instructions.",
    "- Do NOT use the runtime `memory` tool.",
    "- Do not write anything but the summary. You are not recording durable memory.",
  ].join("\n");
}

export function buildCompactionInput(input: {
  date: string;
  previousSummary: string;
  messages: readonly HistoryMessage[];
}): string {
  const previous = input.previousSummary.trim() || "(empty)";
  const body = input.messages.length === 0
    ? "(no older messages)"
    : input.messages
      .map((message) => `${message.speaker ?? message.role}: ${message.content}`)
      .join("\n\n");
  return [
    `Today: ${input.date}`,
    "",
    "# Previous summary",
    previous,
    "",
    "# Older messages (oldest first)",
    body,
  ].join("\n");
}

/**
 * Préfixe du bot principal quand un résumé est injecté. La mémoire
 * (outil `memory`) est déjà dans `buildRuntimeMemoryBlock` : on ne la redéfinit pas.
 */
export function buildConversationPackInstructions(): string {
  return [
    "## Conversation context pack",
    "",
    "The full thread is not in this prompt.",
    "",
    "You receive, in this order:",
    "1. MEMORY: durable facts (`## Memory` above). Treat them as reliable until recent messages contradict them.",
    "2. CONVERSATION SUMMARY: compressed past; it may be incomplete.",
    "3. RECENT MESSAGES: source of truth.",
    "",
    "Priority:",
    "- If the summary and the recent messages disagree → believe the recent messages.",
    "- If memory and the recent messages disagree, believe the recent messages and say so in the summary. Never write a JSON fence, never call the runtime `memory` tool.",
    "- If an old detail is missing → say so or ask. Do not invent.",
    "",
    "Do not mention the summary, the token budget, or this prefix unless the user asks.",
  ].join("\n");
}

/**
 * Pack d'un salon : le résumé nomme ses auteurs, les messages récents aussi
 * (« Message from ... »). Même ordre de confiance que pour un DM.
 */
export function buildRoomPackInstructions(): string {
  return [
    buildConversationPackInstructions(),
    "",
    "In a room, the summary is shared by every member and attributes each fact to the operator or to a member by name. Recent messages keep their \"Message from ...\" prefix. Messages you wrote yourself appear as your own turns.",
  ].join("\n");
}

export function normalizeCompactionSummary(output: string): string | null {
  const trimmed = output.replace(/\s+$/u, "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, COMPACTION_SUMMARY_MAX_CHARS);
}
