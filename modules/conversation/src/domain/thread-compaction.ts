/**
 * Context pack d'un fil : mémoire (ailleurs) + résumé + messages après sa coupe.
 *
 * Le rejeu brut (200 messages / 48 000 caractères) coupait sans rien
 * retenir. Ici le LLM reçoit un résumé structuré du passé et les tours
 * récents intacts. A compaction runs only when the messages after the
 * summary's cut exceed the budget, never on every turn.
 *
 * La mémoire durable reste celle du runtime (outil `memory`), par bot. Ce
 * module ne parle que du résumé **par thread**.
 */

/**
 * History is replayed on EVERY model call of a run, tool rounds included.
 * Measured on 2026-11-16: a 147-message DM replayed 40 500 characters
 * (~10 000 tokens), half of a ~22 000-token « hello ». Over 32 000 characters
 * the thread is replayed as [summary] + every message after the summary's cut,
 * and a compaction runs only when that remainder itself exceeds the budget.
 */
export const HISTORY_CHAR_BUDGET = 32_000;
/**
 * Verbatim tail a compaction leaves behind: half the budget. The next
 * compaction then waits for about half a budget of new conversation, and the
 * replayed prefix (summary + older verbatim messages) stays byte-identical
 * between two compactions, so the provider's prompt cache keeps covering it.
 */
export const KEEP_BUDGET_RATIO = 0.5;
/** Entrée du résumeur : au-delà on plie le plus vieux préfixe d'abord. */
export const COMPACT_INPUT_MAX_CHARS = 80_000;
export const COMPACTION_SUMMARY_MAX_CHARS = 8_000;
/**
 * Longest replayed message once a thread is over budget: head and tail are
 * kept around a marker. The newest message is never shortened (the bot's
 * last answer is what a follow-up most often refers to).
 */
export const REPLAY_MESSAGE_MAX_CHARS = 8_000;
/**
 * A failed compaction is not retried on every turn: only once the remainder
 * has grown by this much, or after `COMPACT_RETRY_AFTER_MS`.
 */
export const COMPACT_RETRY_GROWTH_CHARS = 8_000;
export const COMPACT_RETRY_AFTER_MS = 10 * 60_000;

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
  /** Replayed verbatim after the summary. */
  keep: HistoryMessage[];
  /** What the requested compaction folds; empty when none is needed. */
  old: HistoryMessage[];
  /** The remainder after the summary's cut exceeds the budget (or the row cap hid unsummarized messages). */
  needsCompact: boolean;
  summary: string | null;
  olderExist: boolean;
  /** Characters after the summary's cut: what grows until the next compaction. */
  remainderChars: number;
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

/**
 * Replay = [latest summary] + ALL messages after its cut, verbatim. The cut
 * moves only when that remainder exceeds the budget: the oldest part is then
 * folded and the newest half of the budget stays verbatim. Between two
 * compactions the replay only grows at its end, which keeps it cacheable.
 *
 * The previous design recomputed a sliding KEEP window on every turn: once a
 * thread was over budget, every turn pushed a message out of KEEP that the
 * summary did not cover yet, so every run paid a summarizer call first.
 */
export function planConversationPack(input: {
  messages: readonly HistoryMessage[];
  compaction: ThreadCompaction | null;
  olderExist?: boolean;
  budget?: number;
}): ConversationPackPlan {
  const budget = input.budget ?? HISTORY_CHAR_BUDGET;
  const olderExist = input.olderExist === true;
  const watermark = input.compaction?.compactedThroughSequence ?? null;
  const remainder = watermark === null
    ? [...input.messages]
    : input.messages.filter((message) => message.sequence > watermark);
  const remainderChars = historyCharCount(remainder);
  const summary = input.compaction?.summary ?? null;
  // Rows dropped by the SQL cap are covered only once the cut reaches the window.
  const first = input.messages[0];
  const uncoveredOlder = olderExist && (watermark === null || (first !== undefined && watermark < first.sequence));
  if (remainderChars > budget || uncoveredOlder) {
    const { keep, old } = splitKeepOld(remainder, budget);
    // A lone oversized message has nothing older to fold: replay it as is
    // instead of asking for a compaction that cannot shrink anything.
    if (old.length > 0 || uncoveredOlder) {
      return { keep, old, needsCompact: true, summary, olderExist, remainderChars };
    }
  }
  return { keep: remainder, old: [], needsCompact: false, summary, olderExist, remainderChars };
}

/**
 * Head and tail of an oversized message around a marker, at most `maxChars`
 * long. Deterministic, so a shortened message stays byte-stable across turns.
 */
export function clampReplayedText(content: string, maxChars = REPLAY_MESSAGE_MAX_CHARS): string {
  if (content.length <= maxChars) return content;
  const marker = (omitted: number) => `\n\n[... ${omitted} characters omitted from the middle of this message ...]\n\n`;
  const room = Math.max(0, maxChars - marker(content.length).length);
  let head = Math.ceil(room * 0.6);
  let tailStart = content.length - (room - head);
  // Never split a UTF-16 surrogate pair (emoji) at either cut.
  if (head > 0 && isHighSurrogate(content.charCodeAt(head - 1))) head -= 1;
  if (tailStart < content.length && isLowSurrogate(content.charCodeAt(tailStart))) tailStart += 1;
  return `${content.slice(0, head)}${marker(tailStart - head)}${content.slice(tailStart)}`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** `clampReplayedText` on every message but the newest. */
export function clampReplayedMessages<T extends { content: string }>(
  messages: readonly T[],
  maxChars = REPLAY_MESSAGE_MAX_CHARS,
): T[] {
  return messages.map((message, index) =>
    index === messages.length - 1 || message.content.length <= maxChars
      ? message
      : { ...message, content: clampReplayedText(message.content, maxChars) });
}

/** A failed compaction of a thread: what the remainder weighed, and when. */
export type CompactionFailure = { remainderChars: number; at: number };

/**
 * Whether a compaction may be attempted again after `failure`. A summarizer
 * that is down would otherwise cost every turn its full deadline (60 s).
 */
export function compactionRetryDue(
  failure: CompactionFailure | undefined,
  remainderChars: number,
  now: number,
): boolean {
  if (!failure) return true;
  return remainderChars >= failure.remainderChars + COMPACT_RETRY_GROWTH_CHARS
    || now - failure.at >= COMPACT_RETRY_AFTER_MS;
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
 * Assemble l'historique Hermes : résumé (s'il existe) + messages après sa coupe.
 * Aucun horodatage ni contenu propre au tour : le bloc ne change qu'à sa fin
 * entre deux compactions.
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
