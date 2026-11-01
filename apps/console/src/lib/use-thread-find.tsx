import { useEffect, useMemo, useState } from "react";
import type { ThreadMessageDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { MentionableBot } from "@openedbot/roster/domain/mentions";
import {
  buildThreadFindIndex,
  searchThreadFindIndex,
  type ThreadFindDocument,
} from "@openedbot/conversation/domain/thread-find";
import { FindBar } from "../components/find-bar";
import { useT } from "./i18n";

const NO_DOCUMENTS: readonly ThreadFindDocument[] = [];

export function useThreadFind(input: {
  messages: readonly ThreadMessageDto[];
  events: readonly StoredProductEvent[];
  mentionables?: readonly MentionableBot[];
  operatorUsername?: string | null;
}) {
  const { t, locale } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [currentMatchId, setCurrentMatchId] = useState<string | null>(null);
  // Indexed only while the bar is open (OHB-135): the index walks every
  // message and event of the loaded thread, and the 202 of a send and each
  // SSE flush hand this hook a new `events` array.
  const documents = useMemo(
    () => open
      ? buildThreadFindIndex(input.messages, input.events, {
        locale,
        mentionables: input.mentionables,
        operatorUsername: input.operatorUsername,
      })
      : NO_DOCUMENTS,
    [open, input.events, input.mentionables, input.messages, input.operatorUsername, locale],
  );
  const result = useMemo(
    () => searchThreadFindIndex(documents, query, currentMatchId),
    [currentMatchId, documents, query],
  );
  const activeMatch = open && result.currentIndex >= 0 ? result.matches[result.currentIndex] ?? null : null;

  useEffect(() => {
    if (!activeMatch) return;
    const target = [...globalThis.document.querySelectorAll<HTMLElement>("[data-thread-find-target]")]
      .find((element) => element.dataset.threadFindTarget === activeMatch.targetId);
    target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [activeMatch]);

  return {
    activeTargetId: activeMatch?.targetId ?? null,
    bar: (
      <FindBar
        open={open}
        query={query}
        matchCount={result.matches.length}
        currentIndex={result.currentIndex}
        labels={{
          search: t("threadFind.search"),
          placeholder: t("threadFind.placeholder"),
          previous: t("threadFind.previous"),
          next: t("threadFind.next"),
          close: t("threadFind.close"),
          noResults: t("threadFind.noResults"),
          resultPosition: (current, total) => t("threadFind.position", { current, total }),
        }}
        onOpenChange={setOpen}
        onQueryChange={(value) => {
          setQuery(value);
          setCurrentMatchId(null);
        }}
        onCurrentIndexChange={(index) => setCurrentMatchId(result.matches[index]?.id ?? null)}
      />
    ),
  };
}
