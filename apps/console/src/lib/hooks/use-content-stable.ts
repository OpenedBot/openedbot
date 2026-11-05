import { useRef } from "react";
import type { MessageAuthorBot } from "@openedbot/contracts-api";

/**
 * Keeps the previous reference while `equal` says the content did not change.
 *
 * A roster patch (the 202 of a send, the read receipt, every SSE flush)
 * rebuilds the whole `RosterDto`, so a `useMemo` keyed on it hands the thread a
 * new Map or array with the same content. `ThreadTimeline` and its model
 * builder compare those props by reference: each new identity re-ran the
 * block plan and every turn signature.
 */
export function useContentStable<T>(next: T, equal: (previous: T, next: T) => boolean): T {
  const kept = useRef(next);
  if (kept.current !== next && !equal(kept.current, next)) kept.current = next;
  return kept.current;
}

function authorKey(author: Pick<MessageAuthorBot, "id" | "name" | "slug" | "face">): string {
  return `${author.id}:${author.name ?? ""}:${author.slug ?? ""}:${JSON.stringify(author.face ?? null)}`;
}

export function sameAuthorList(
  previous: readonly Pick<MessageAuthorBot, "id" | "name" | "slug" | "face">[],
  next: readonly Pick<MessageAuthorBot, "id" | "name" | "slug" | "face">[],
): boolean {
  return previous.length === next.length
    && previous.every((author, index) => authorKey(author) === authorKey(next[index]!));
}

export function sameAuthorMap(
  previous: ReadonlyMap<string, Pick<MessageAuthorBot, "id" | "name" | "slug" | "face">>,
  next: ReadonlyMap<string, Pick<MessageAuthorBot, "id" | "name" | "slug" | "face">>,
): boolean {
  if (previous.size !== next.size) return false;
  for (const [key, author] of next) {
    const before = previous.get(key);
    if (!before || authorKey(before) !== authorKey(author)) return false;
  }
  return true;
}

export function sameValueMap<V>(previous: ReadonlyMap<string, V>, next: ReadonlyMap<string, V>): boolean {
  if (previous.size !== next.size) return false;
  for (const [key, value] of next) {
    if (!previous.has(key) || previous.get(key) !== value) return false;
  }
  return true;
}
