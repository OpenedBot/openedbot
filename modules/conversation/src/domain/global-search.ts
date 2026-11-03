import type { MessageContent } from "@openedbot/contracts-api";
import { splitHandoff } from "@openedbot/roster/domain/bot-mode";
import type { MentionableBot } from "@openedbot/roster/domain/mentions";
import { splitAskUser } from "@openedbot/roster/domain/ask-user";

export const GLOBAL_SEARCH_LIMITS = {
  defaultResults: 12,
  maxResults: 40,
  maxQueryChars: 200,
  /** Mirrors the bounded message window returned by GET /threads/:id. */
  mountedMessagesPerThread: 1_000,
} as const;

export type GlobalSearchHitDto = {
  kind: "conversation" | "message";
  threadId: string;
  /** Stable `data-thread-find-target`, or null for a conversation-title hit. */
  targetId: string | null;
  botSlug: string | null;
  groupId: string | null;
  conversationName: string;
  role: "user" | "assistant" | null;
  authorName: string | null;
  snippet: string;
  matchStart: number;
  matchLength: number;
  occurredAt: string;
};

export type GlobalSearchPageDto = { hits: GlobalSearchHitDto[] };

/**
 * Extracts only fields already rendered by a message bubble. Reasoning and
 * tool-call payloads are deliberately absent, even when they are persisted in
 * the same JSON document.
 */
export function globalSearchVisibleMessageText(
  content: MessageContent,
  role: "user" | "assistant",
  options: {
    mentionables?: readonly MentionableBot[];
    operatorUsername?: string | null;
  } = {},
): string {
  // JSONB is an external boundary even if callers normally hydrate the shared
  // type. A legacy or manually-written malformed part must produce no result,
  // not crash every member's global search or stringify a private payload.
  const parts: readonly unknown[] = Array.isArray(content) ? content : [];
  const text = parts.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const candidate = part as Record<string, unknown>;
    if (candidate.type === "text" && typeof candidate.text === "string") return [candidate.text];
    if (candidate.type === "attachment" && typeof candidate.name === "string") return [candidate.name];
    return [];
  }).join("\n");
  if (role === "user") return text;

  const ask = splitAskUser(
    text,
    options.operatorUsername ? { username: options.operatorUsername } : null,
  );
  const withQuestion = ask.prompt
    ? [ask.body, ask.prompt.question].filter(Boolean).join("\n")
    : text;

  // Search is a discovery surface, so it uses the conservative form of the
  // transcript rule: a terminal bot-to-bot directive is never placed in an
  // excerpt. The conversation itself still explains an executed/refused
  // hand-off through its public notice.
  const handoff = splitHandoff(withQuestion, options.mentionables ?? []);
  return handoff.handoff ? handoff.body : withQuestion;
}

type NormalizedText = { value: string; starts: number[]; ends: number[] };

function expandGlobalSearchLatin(character: string): string {
  switch (character) {
    case "Œ": case "œ": return "oe";
    case "Æ": case "æ": return "ae";
    case "ẞ": case "ß": return "ss";
    case "Þ": case "þ": return "th";
    case "Ø": case "ø": return "o";
    case "Ł": case "ł": return "l";
    case "Đ": case "đ": case "Ð": case "ð": return "d";
    default: return character;
  }
}

function normalizeWithOffsets(text: string): NormalizedText {
  let value = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let sourceOffset = 0;
  for (const character of text) {
    const normalized = expandGlobalSearchLatin(character)
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase();
    value += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      starts.push(sourceOffset);
      ends.push(sourceOffset + character.length);
    }
    sourceOffset += character.length;
  }
  return { value, starts, ends };
}

/** Produces a plain-text, offset-safe excerpt; consumers never inject HTML. */
export function globalSearchSnippet(
  text: string,
  query: string,
): Pick<GlobalSearchHitDto, "snippet" | "matchStart" | "matchLength"> | null {
  const normalized = normalizeWithOffsets(text);
  const whole = normalizeWithOffsets(query.trim()).value;
  const terms = whole.split(/\s+/u).filter(Boolean);
  if (!whole || terms.length === 0) return null;

  let found = normalized.value.indexOf(whole);
  let foundLength = whole.length;
  if (found < 0) {
    const occurrences = terms
      .map((term) => ({ index: normalized.value.indexOf(term), length: term.length }))
      .filter((item) => item.index >= 0)
      .sort((left, right) => left.index - right.index);
    const first = occurrences[0];
    if (!first) return null;
    found = first.index;
    foundLength = first.length;
  }

  const start = normalized.starts[found];
  const end = normalized.ends[found + foundLength - 1];
  if (start === undefined || end === undefined) return null;
  const radius = 72;
  const excerptStart = Math.max(0, start - radius);
  const excerptEnd = Math.min(text.length, end + radius);
  const prefix = excerptStart > 0 ? "…" : "";
  const suffix = excerptEnd < text.length ? "…" : "";
  return {
    snippet: `${prefix}${text.slice(excerptStart, excerptEnd).replace(/\s+/gu, " ").trim()}${suffix}`,
    // Whitespace folding above can shift an offset. Re-find within the public
    // excerpt; a miss yields a zero-length mark rather than highlighting text
    // unrelated to the query.
    matchStart: 0,
    matchLength: end - start,
  };
}

/** Recomputes the final offset after excerpt whitespace has been folded. */
export function finalizeGlobalSearchSnippet(
  value: Pick<GlobalSearchHitDto, "snippet" | "matchStart" | "matchLength">,
  query: string,
): Pick<GlobalSearchHitDto, "snippet" | "matchStart" | "matchLength"> {
  const snippet = normalizeWithOffsets(value.snippet);
  const normalizedQuery = normalizeWithOffsets(query.trim()).value;
  const terms = normalizedQuery.split(/\s+/u).filter(Boolean);
  let found = snippet.value.indexOf(normalizedQuery);
  let length = normalizedQuery.length;
  if (found < 0) {
    const occurrence = terms
      .map((term) => ({ index: snippet.value.indexOf(term), length: term.length }))
      .filter((item) => item.index >= 0)
      .sort((left, right) => left.index - right.index)[0];
    if (!occurrence) return { ...value, matchStart: 0, matchLength: 0 };
    found = occurrence.index;
    length = occurrence.length;
  }
  const start = snippet.starts[found];
  const end = snippet.ends[found + length - 1];
  return {
    ...value,
    matchStart: start ?? 0,
    matchLength: start === undefined || end === undefined ? 0 : end - start,
  };
}
