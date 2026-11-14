import { useEffect, useMemo, useState } from "react";
import type { RunDto, ThreadMessageDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { MentionableBot } from "@openedbot/roster/domain/mentions";
import {
  buildThreadFindIndex,
  searchThreadFindIndex,
  type ThreadFindDocument,
} from "@openedbot/roster/domain/thread-find";
import { FindBar } from "../../components/find-bar";
import { requestThreadReveal } from "./thread-reveal";
import { useT } from "../i18n";

const NO_DOCUMENTS: readonly ThreadFindDocument[] = [];

export function useThreadFind(input: {
  messages: readonly ThreadMessageDto[];
  events: readonly StoredProductEvent[];
  runs?: readonly Pick<RunDto, "id" | "routineId">[];
  mentionables?: readonly MentionableBot[];
  operatorUsername?: string | null;
}) {
  const { t, locale } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [currentMatchId, setCurrentMatchId] = useState<string | null>(null);
  // Indexed only while the bar is open: the index walks every
  // message and event of the loaded thread, and the 202 of a send and each
  // SSE flush hand this hook a new `events` array.
  const documents = useMemo(
    () => {
      if (!open) return NO_DOCUMENTS;
      const routineRuns = new Set((input.runs ?? []).filter((run) => run.routineId).map((run) => run.id));
      const messages = input.messages.filter((message) => message.role !== "user" || !message.runId || !routineRuns.has(message.runId));
      return buildThreadFindIndex(messages, input.events, {
        locale, mentionables: input.mentionables, operatorUsername: input.operatorUsername,
      });
    },
    [open, input.events, input.mentionables, input.messages, input.runs, input.operatorUsername, locale],
  );
  const result = useMemo(
    () => searchThreadFindIndex(documents, query, currentMatchId),
    [currentMatchId, documents, query],
  );
  const activeMatch = open && result.currentIndex >= 0 ? result.matches[result.currentIndex] ?? null : null;

  // The thread lands on the match, mounting its turn when it is out of the
  // mounted rows (`thread-timeline.tsx`, virtual rows).
  useEffect(() => {
    if (!activeMatch) return;
    requestThreadReveal(activeMatch.targetId, { block: "center", behavior: "smooth" });
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
