import type { ThreadMessageDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { MentionableBot } from "./mentions";
import {
  handoffDirectiveNotices,
  splitHandoff,
} from "./bot-mode";
import { DEFAULT_LOCALE, type Locale } from "@openedbot/contracts-locale";
import { splitAskUser } from "./ask-user";
import { t } from "@openedbot/contracts-i18n";
import { readAttachment, toolCallKey, toolLabel } from "@openedbot/conversation/domain/thread-tools";

export type ThreadFindDocument = {
  /** Stable DOM/navigation target: message id or first event cursor of a visible block. */
  targetId: string;
  kind: "message" | "event";
  text: string;
};

export type ThreadFindMatch = {
  /** Stable while the source text before this occurrence does not change. */
  id: string;
  targetId: string;
  kind: ThreadFindDocument["kind"];
  excerpt: string;
  excerptMatchStart: number;
  excerptMatchLength: number;
};

export type ThreadFindResult = {
  query: string;
  matches: ThreadFindMatch[];
  /** `-1` when no match exists, otherwise always in `[0, matches.length)`. */
  currentIndex: number;
};

export type BuildThreadFindIndexOptions = {
  locale?: Locale;
  mentionables?: readonly MentionableBot[];
  operatorUsername?: string | null;
  /**
   * Enable this only for clients which actually render persisted assistant
   * messages. The web timeline renders assistant output from product events,
   * while the native timeline replaces those events with persisted turns.
   */
  includePersistedAssistantMessages?: boolean;
};

function eventPayloadText(event: StoredProductEvent): string {
  const value = event.payload.text ?? event.payload.message ?? event.payload.output;
  return typeof value === "string" ? value : "";
}

function visibleAssistantText(
  text: string,
  runId: string | null,
  notices: ReturnType<typeof handoffDirectiveNotices>,
  options: BuildThreadFindIndexOptions,
): string {
  const ask = splitAskUser(
    text,
    options.operatorUsername ? { username: options.operatorUsername } : null,
  );
  const withQuestion = ask.prompt
    ? [ask.body, ask.prompt.question].filter(Boolean).join("\n")
    : text;
  if (!runId) return withQuestion;

  const notice = notices.get(runId);
  if (!notice) return withQuestion;
  const mentionables = notice.target
    ? [...(options.mentionables ?? []), notice.target]
    : [...(options.mentionables ?? [])];
  const split = splitHandoff(withQuestion, mentionables);
  if (!split.handoff) return withQuestion;
  return notice.outcome === "relayed"
    ? [split.body, split.handoff.message].filter(Boolean).join("\n")
    : split.body;
}

function messageText(
  message: ThreadMessageDto,
  notices: ReturnType<typeof handoffDirectiveNotices>,
  options: BuildThreadFindIndexOptions,
): string {
  const visibleParts = message.content.flatMap((part) => {
    if (part.type === "text") return [part.text];
    if (part.type === "attachment") return [part.name];
    // Reasoning and tool-call payloads are internal even though they are stored
    // inside a message. They must never leak through search excerpts.
    return [];
  });
  const text = visibleParts.join("\n");
  return message.role === "assistant"
    ? visibleAssistantText(text, message.runId, notices, options)
    : text;
}

/**
 * Builds the searchable transcript from the same public concepts the timeline
 * renders. Raw/reasoning/signalling events are an explicit deny-list: adding a
 * payload field to them can never make it searchable by accident.
 */
export function buildThreadFindIndex(
  messages: readonly ThreadMessageDto[],
  events: readonly StoredProductEvent[],
  options: BuildThreadFindIndexOptions = {},
): ThreadFindDocument[] {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const notices = handoffDirectiveNotices(events);
  const orderedDocuments: Array<ThreadFindDocument & { time: number; order: number }> = [];
  const pushDocument = (document: ThreadFindDocument, occurredAt: string | Date) => {
    const parsed = new Date(occurredAt).getTime();
    orderedDocuments.push({
      ...document,
      time: Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER,
      order: orderedDocuments.length,
    });
  };

  for (const message of messages) {
    // The timeline renders persisted user/bot-originated messages from this
    // collection, while assistant output is rendered from `agent.message`
    // events below. Indexing both would create duplicate matches and point the
    // persisted assistant copy at a DOM target which does not exist.
    if (message.role !== "user" && !options.includePersistedAssistantMessages) continue;
    const text = messageText(message, notices, options).trim();
    if (text) {
      pushDocument(
        { targetId: `message:${message.id}`, kind: "message", text },
        message.createdAt,
      );
    }
  }

  const passedRuns = new Set(
    events
      .filter((event) => event.type === "system.notice" && event.payload.kind === "group.pass")
      .map((event) => event.runId),
  );
  const attachedResults = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "tool.result.attached") continue;
    const attachment = readAttachment(event.payload);
    if (attachment && "result" in attachment && typeof attachment.result === "string") {
      attachedResults.set(toolCallKey(event), attachment.result);
    }
  }

  type AssistantBlock = { runId: string; cursor: number; text: string; occurredAt: Date };
  let assistantBlock: AssistantBlock | null = null;
  const flushAssistant = () => {
    if (!assistantBlock) return;
    const text = visibleAssistantText(assistantBlock.text, assistantBlock.runId, notices, options).trim();
    if (text) {
      pushDocument(
        {
          targetId: `event:${assistantBlock.runId}:${assistantBlock.cursor}`,
          kind: "event",
          text,
        },
        assistantBlock.occurredAt,
      );
    }
    assistantBlock = null;
  };

  for (const event of events) {
    if (event.type === "agent.message") {
      if (passedRuns.has(event.runId)) continue;
      const text = eventPayloadText(event);
      // The flushing closure mutates this binding; keep a local snapshot so
      // TypeScript does not narrow the cross-iteration value to its initializer.
      const currentBlock = assistantBlock as AssistantBlock | null;
      if (currentBlock?.runId === event.runId) currentBlock.text += text;
      else {
        flushAssistant();
        assistantBlock = {
          runId: event.runId,
          cursor: event.cursor,
          text,
          occurredAt: event.occurredAt,
        };
      }
      continue;
    }

    // Events which render nowhere also do not split adjacent streamed text.
    if (
      event.type === "agent.reasoning" ||
      event.type === "tool.result" ||
      event.type === "tool.result.attached" ||
      event.type === "approval.requested" ||
      event.type === "run.completed" ||
      event.type === "bot.message" ||
      event.type === "raw" ||
      (event.type === "system.notice" && event.payload.kind === "group.pass")
    ) {
      continue;
    }

    flushAssistant();
    let text = "";
    switch (event.type) {
      case "tool.call": {
        const tool = String(event.payload.tool ?? "");
        const label = toolLabel(locale, tool);
        const preview = typeof event.payload.preview === "string" ? event.payload.preview : "";
        const result = attachedResults.get(toolCallKey(event)) ?? "";
        text = [label, tool, preview, result].filter(Boolean).join("\n");
        break;
      }
      case "run.error":
        text = eventPayloadText(event) || t(locale, "threadTimeline.runtimeErrorFallback");
        break;
      case "run.provider_fallback":
        text = eventPayloadText(event);
        break;
      case "system.notice":
        text = eventPayloadText(event);
        break;
      default:
        break;
    }
    if (text.trim()) {
      pushDocument(
        {
          targetId: `event:${event.runId}:${event.cursor}`,
          kind: "event",
          text: text.trim(),
        },
        event.occurredAt,
      );
    }
  }
  flushAssistant();
  return orderedDocuments
    .sort((left, right) => left.time - right.time || left.order - right.order)
    .map(({ time: _time, order: _order, ...document }) => document);
}

type NormalizedText = { value: string; starts: number[]; ends: number[] };

function normalizeWithOffsets(text: string): NormalizedText {
  let value = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let sourceOffset = 0;
  for (const character of text) {
    const normalized = character.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
    value += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      starts.push(sourceOffset);
      ends.push(sourceOffset + character.length);
    }
    sourceOffset += character.length;
  }
  return { value, starts, ends };
}

function excerpt(text: string, start: number, end: number): Pick<ThreadFindMatch, "excerpt" | "excerptMatchStart" | "excerptMatchLength"> {
  const radius = 48;
  const excerptStart = Math.max(0, start - radius);
  const excerptEnd = Math.min(text.length, end + radius);
  const prefix = excerptStart > 0 ? "…" : "";
  const suffix = excerptEnd < text.length ? "…" : "";
  return {
    excerpt: `${prefix}${text.slice(excerptStart, excerptEnd)}${suffix}`,
    excerptMatchStart: prefix.length + start - excerptStart,
    excerptMatchLength: end - start,
  };
}

export function searchThreadFindIndex(
  documents: readonly ThreadFindDocument[],
  query: string,
  currentMatchId: string | null = null,
): ThreadFindResult {
  const normalizedQuery = normalizeWithOffsets(query.trim()).value;
  if (!normalizedQuery) return { query, matches: [], currentIndex: -1 };

  const matches: ThreadFindMatch[] = [];
  for (const document of documents) {
    const normalized = normalizeWithOffsets(document.text);
    let fromIndex = 0;
    while (fromIndex <= normalized.value.length - normalizedQuery.length) {
      const found = normalized.value.indexOf(normalizedQuery, fromIndex);
      if (found < 0) break;
      const start = normalized.starts[found];
      const end = normalized.ends[found + normalizedQuery.length - 1];
      if (start !== undefined && end !== undefined) {
        matches.push({
          id: `${document.targetId}:${start}:${end}`,
          targetId: document.targetId,
          kind: document.kind,
          ...excerpt(document.text, start, end),
        });
      }
      fromIndex = found + Math.max(1, normalizedQuery.length);
    }
  }

  const preserved = currentMatchId
    ? matches.findIndex((match) => match.id === currentMatchId)
    : -1;
  return { query, matches, currentIndex: matches.length === 0 ? -1 : Math.max(0, preserved) };
}

/** Wraps in both directions, like native in-page find. */
export function stepThreadFindIndex(currentIndex: number, matchCount: number, delta: -1 | 1): number {
  if (matchCount <= 0) return -1;
  const safeCurrent = currentIndex >= 0 && currentIndex < matchCount ? currentIndex : 0;
  return (safeCurrent + delta + matchCount) % matchCount;
}
