import { memo, useId, useState } from "react";
import { Brain, ChevronDown, Search, Sparkles } from "lucide-react";
import { cn } from "@openedbot/browser-ui-kit";
import type { MessageAuthorBot } from "@openedbot/contracts-api";
import type { WebSearchQuery, WebSearchTrail } from "@openedbot/execution/domain/agent-web-search";
import { isTodoTool } from "@openedbot/execution/domain/agent-tool-call";
import {
  formatToolDuration,
  toolFailureSummary,
  toolKind,
  type ToolCall,
  type ToolKind,
} from "@openedbot/conversation/domain/thread-tools";
import { useT } from "../lib/i18n";
import { toolProgressLabel } from "../lib/run/tool-progress-label";
import { ActivityDisclosure } from "./activity-disclosure";
import { TurnAuthorHeader } from "./thread-author";
import { ThreadMarkdown } from "./thread-markdown";
import { SearchSources } from "./thread-search-sources";
import { activityKindSummary, partialFailureLabel } from "./thread-tool-labels";
import { ThinkingStatus } from "./thread-thinking-status";
import { ToolStateIcon } from "./thread-tool-state-icon";

/** One row of the feed. Rows enter with a fade and a short rise while the turn is live. */
export function ActivityRow({ kind, className, children }: {
  kind: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="listitem" data-activity-row={kind} className={cn("min-w-0", className)}>
      {children}
    </div>
  );
}

/**
 * A sentence the model wrote between two tools: its thinking out loud, read
 * as a « Thinking » trace row of the feed, not as the answer.
 */
export function ActivityNarration({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="grid min-h-8 grid-cols-[1rem_minmax(0,1fr)] items-start gap-2.5 rounded-md px-1.5 py-1">
      <span aria-hidden className="grid h-6 w-4 place-items-center text-text-tertiary">
        <Sparkles className="size-4" />
      </span>
      <div
        data-activity-narration=""
        className="prose prose-sm max-w-none wrap-anywhere py-0.5 text-sm leading-5 dark:prose-invert prose-p:my-1 prose-p:text-text-secondary [&>:first-child]:mt-0 [&>:last-child]:mb-0"
      >
        <ThreadMarkdown streaming={streaming}>{text}</ThreadMarkdown>
      </div>
    </div>
  );
}

function SearchQueryRow({ query }: { query: WebSearchQuery }) {
  const { t, plural } = useT();
  const resultLabel = query.resultCount === null
    ? null
    : plural(query.resultCount, {
        one: t("agentActivity.searchResults_one", { count: query.resultCount }),
        other: t("agentActivity.searchResults_other", { count: query.resultCount }),
      });
  return (
    <ActivityRow kind="search" className="space-y-0.5">
      <div className="flex min-h-7 min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1 text-text-secondary">
        <Search aria-hidden strokeWidth={1.7} className="size-4 shrink-0 text-text-tertiary" />
        <span data-search-query="" className="min-w-0 truncate">{query.query}</span>
        {resultLabel ? <span className="shrink-0 text-xs tabular-nums text-text-tertiary">{resultLabel}</span> : null}
      </div>
      <SearchSources query={query} />
    </ActivityRow>
  );
}

/**
 * The web searches of a turn, one row per query: the query, then its first
 * results (title, domain), then « +N autres », a button that lists every
 * other source. Sources come from the run's transcript
 * (`agent-web-search.ts`), never a favicon fetched from a third party: a
 * site glyph is drawn locally.
 */
export function ActivitySearch({ trail }: { trail: WebSearchTrail }) {
  return (
    <>
      {trail.queries.map((query) => <SearchQueryRow key={query.id} query={query} />)}
    </>
  );
}

/**
 * L'activité d'un tour, en UN bloc, as the « Assistant » template of
 * streaming-ui.pulseview.app on BoardUI tokens: a chronological list of what
 * the agent did (its sentences, web searches with their results, reads,
 * edits, commands, decisions), each tool as a Tool Result (component 12).
 * While the run works, the list is open at its natural height; once the turn
 * concludes it folds into one line, « A travaillé 6 s », the tool families
 * (« 2 recherches web et 3 commandes ») and its failures. The answer stays
 * below, outside the block. The live status itself (Thinking Shimmer) is the
 * dock above the composer (`run-activity-dock.tsx`), not this header.
 *
 * A pending decision or a find target forces the block open: a question for
 * the operator never hides in a fold. A turn that ended with a failed tool
 * stays open too, so the failed Tool Result (open on its error) still reads
 * without a click. The operator's click wins over the automatic open and
 * fold.
 */
export const TurnActivity = memo(function TurnActivity({
  calls,
  live,
  forceOpen,
  author,
  showAuthorLabel,
  children,
  settled = false,
  workedMs = null,
  since = null,
  answering = false,
  waiting = false,
}: {
  calls: readonly ToolCall[];
  live: boolean;
  /** The run's own duration (created to ended), once it has one. */
  workedMs?: number | null;
  /** Une décision attend, ou la recherche du fil vise une entrée du bloc. */
  forceOpen: boolean;
  author: MessageAuthorBot | null;
  showAuthorLabel: boolean;
  children: React.ReactNode;
  /** Hors des derniers tours et du direct : `content-visibility: auto`. */
  settled?: boolean;
  /** The run's real start (epoch ms): where the thinking timer counts from. */
  since?: number | null;
  /** The answer has started streaming below: the live status folds to its summary line. */
  answering?: boolean;
  /** The agent waits for the operator (a pending decision): no thinking animation. */
  waiting?: boolean;
}) {
  const { t, plural, formatNumber, locale } = useT();
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const bodyId = useId();
  const visibleCalls = calls.filter((call) => !isTodoTool(call.tool));
  const failedCalls = visibleCalls.filter((call) => call.failed);
  const failedCount = failedCalls.length;
  // A failure stays open: folding the turn would hide the failed Tool Result
  // that keeps its error on screen.
  const thinking = live && !answering && !waiting;
  // "Thought for 2s": the answer starting freezes the timer where it stood.
  const [mountedAt] = useState(() => Date.now());
  const start = since ?? mountedAt;
  const [frozenMs, setFrozenMs] = useState<number | null>(null);
  if (live && answering && frozenMs === null) setFrozenMs(Math.max(0, Date.now() - start));
  const expanded = forceOpen || (userExpanded ?? (thinking || waiting || failedCount > 0));
  const onHeadClick = () => setUserExpanded(!expanded);
  const partial = failedCount > 0 && failedCount < visibleCalls.length;
  const failureSummary = failedCount === 1
    ? toolFailureSummary({ errorMessages: failedCalls.flatMap((call) => call.errorMessage ? [call.errorMessage] : []) })
    : null;
  const failureTitle = failedCalls.find((call) => call.errorMessage)?.errorMessage ?? null;
  const durations = visibleCalls
    .map((call) => call.durationMs)
    .filter((value): value is number => typeof value === "number");
  const totalDuration = durations.length ? durations.reduce((sum, value) => sum + value, 0) : null;
  const kinds = new Map<ToolKind, number>();
  for (const call of visibleCalls) {
    const kind = toolKind(call.tool);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  // The tool the runtime started and has not closed: the live line names it
  // (« Recherche : cours du bitcoin ») instead of the generic « Réfléchit… ».
  const runningCall = thinking ? visibleCalls.findLast((call) => !call.done) : undefined;
  const runningLabel = runningCall ? toolProgressLabel(t, runningCall.tool, runningCall.preview) : undefined;
  const kindSummary = activityKindSummary(t, plural, locale, kinds);
  // « A travaillé 6 s » from the run itself, else from its tools' durations.
  const worked = workedMs ?? (live ? frozenMs : null) ?? totalDuration;
  const heading = live && !answering
    ? t("threadTimeline.activityWorking")
    : worked !== null
      ? t("threadTimeline.activityWorked", { duration: formatToolDuration(worked, formatNumber) })
      : kindSummary ?? t("threadTimeline.activityDone");
  const block = (
    <section
      data-turn-activity=""
      data-live={live ? "" : undefined}
      data-thinking={thinking ? "" : undefined}
      aria-label={t("threadTimeline.activityFeed")}
      aria-busy={live}
      className={cn(
        "flex w-full min-w-0 max-w-full flex-col self-start text-body-regular text-text-secondary",
        settled && "ohb-turn-contain",
      )}
    >
      <button
        type="button"
        data-activity-head=""
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onHeadClick}
        className="group flex min-h-7 w-fit max-w-full min-w-0 origin-left cursor-pointer items-center gap-2 rounded-md py-1 text-left text-body-2-medium text-text-secondary outline-none transition-[color,scale] hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring active:scale-[0.98] motion-reduce:transition-none"
      >
        {thinking ? (
          <span data-activity-summary="" className="min-w-0">
            <ThinkingStatus since={start} label={runningLabel} announce={false} />
          </span>
        ) : (
          <>
            <span aria-hidden className="grid size-4 shrink-0 place-items-center">
              {failedCount > 0
                ? <ToolStateIcon done failed={!partial} partial={partial} />
                : <Brain className="size-4" />}
            </span>
            <span data-activity-summary="" className="min-w-0 truncate">
              {heading}
            </span>
          </>
        )}
        {!live && worked !== null && kindSummary ? (
          <span data-activity-kinds="" className="min-w-0 shrink truncate font-normal text-text-tertiary">· {kindSummary}</span>
        ) : null}
        {failedCount > 0 ? (
          <span
            className={cn("shrink-0", partial ? "text-warn-700" : "text-destructive-text")}
            data-tool-partial-failure={partial ? "" : undefined}
            data-tool-failure-reason={failureSummary ? "" : undefined}
            title={failureSummary ? failureTitle ?? undefined : undefined}
          >
            {failureSummary
              ? t("threadTimeline.toolFailureWithReason", {
                  status: partial ? partialFailureLabel(t, plural, failedCount, visibleCalls.length) : t("threadTimeline.toolFailed"),
                  reason: failureSummary,
                })
              : partialFailureLabel(t, plural, failedCount, visibleCalls.length)}
          </span>
        ) : null}
        <ChevronDown
          aria-hidden
          className={cn("ohb-activity-chevron size-4 shrink-0 text-text-tertiary group-hover:text-text-primary", !expanded && "-rotate-90")}
        />
        <span className="sr-only">
          {expanded ? t("threadTimeline.activityCollapse") : t("threadTimeline.activityExpand")}
        </span>
      </button>
      <ActivityDisclosure open={expanded} id={bodyId}>
        <div role="list" data-activity-list="" className="ohb-activity-list flex flex-col gap-0.5 py-1">
          {children}
        </div>
      </ActivityDisclosure>
    </section>
  );
  if (!author || !showAuthorLabel) return block;
  const label = author.name ?? author.slug ?? t("threadTimeline.unknownBot");
  return <TurnAuthorHeader author={author} label={label}>{block}</TurnAuthorHeader>;
});
