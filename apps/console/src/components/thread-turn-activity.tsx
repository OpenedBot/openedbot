import { memo, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Search, Sparkles } from "lucide-react";
import { cn } from "@openedbot/browser-ui-kit";
import type { MessageAuthorBot } from "@openedbot/contracts-api";
import type { WebSearchQuery, WebSearchTrail } from "@openedbot/execution/domain/agent-web-search";
import { isTodoTool } from "@openedbot/execution/domain/agent-tool-call";
import type { ToolCall } from "@openedbot/conversation/domain/thread-tools";
import { useT } from "../lib/i18n";
import { TurnAuthorHeader } from "./thread-author";
import { ThreadMarkdown } from "./thread-markdown";
import { SearchSources } from "./thread-search-sources";
import { partialFailureLabel } from "./thread-tool-labels";
import { BotFace } from "./bot-face";
import { AgentFeed } from "./grok/agent-feed";
import { GrokAgentsHeader, GrokFeedRow, type GrokFeedItem } from "./grok/grok-feed";
import { GrokThoughtsPanel } from "./grok/grok-thoughts-panel";
import { grokSpeaker } from "./grok/turn-feed";
import { useAttachmentCanvas } from "./attachment-canvas";

/** grok.com's first beat: the bulb before the agents are called. */
const PRE_BEAT_MS = 400;

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
 * L'activité d'un tour, as grok.com's chat (streaming-ui Grok template, Heavy
 * mode): `AgentsHeader` over `AgentFeed`. While the run works, the header
 * reads « Réflexion • Ns » (the bot's face springs in at its first step) and
 * the feed rolls its last three steps, blurring in below and out above. Once
 * the answer streams the feed empties and the header reads « Réflexions »,
 * then « Réflexion : Ns ». A click on it opens grok's « Réflexions » panel in
 * the thread's canvas (`GrokThoughtsPanel`), the turn's whole log; a second
 * click, or its close button, folds it.
 *
 * The detailed rows (Tool Results, sources, decisions) stay in the thread,
 * folded: a pending decision or a find target opens them in place, so a
 * question for the operator never hides. A screen without a canvas (tests,
 * embeds) keeps that fold as its log, opened on a failed turn.
 */
export const TurnActivity = memo(function TurnActivity({
  calls,
  feed = [],
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
  /** The turn's steps as grok.com's feed rows (`turnFeed`). */
  feed?: readonly GrokFeedItem[];
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
  /** The answer has started streaming below: the feed empties, « Réflexions ». */
  answering?: boolean;
  /** The agent waits for the operator (a pending decision). */
  waiting?: boolean;
}) {
  const { t, plural } = useT();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const bodyId = useId();
  const visibleCalls = calls.filter((call) => !isTodoTool(call.tool));
  const failedCalls = visibleCalls.filter((call) => call.failed);
  const failedCount = failedCalls.length;
  const partial = failedCount > 0 && failedCount < visibleCalls.length;
  const [mountedAt] = useState(() => Date.now());
  const start = since ?? mountedAt;
  // grok's first beat: the bulb and « Réflexion pendant Ns » for 400 ms.
  const [pre, setPre] = useState(() => live && Date.now() - start < PRE_BEAT_MS);
  useEffect(() => {
    if (!pre) return;
    const timer = window.setTimeout(() => setPre(false), Math.max(0, PRE_BEAT_MS - (Date.now() - start)));
    return () => window.clearTimeout(timer);
  }, [pre, start]);
  // « Réflexion : 23s » freezes where the answer started.
  const [frozenMs, setFrozenMs] = useState<number | null>(null);
  if (live && answering && frozenMs === null) setFrozenMs(Math.max(0, Date.now() - start));
  const durations = visibleCalls.map((call) => call.durationMs).filter((value): value is number => typeof value === "number");
  const totalDuration = durations.length ? durations.reduce((sum, value) => sum + value, 0) : null;
  const worked = workedMs ?? (live ? frozenMs : null) ?? totalDuration;
  const running = live && !answering;
  const rolling = running && !waiting && !forceOpen;
  const canvas = useAttachmentCanvas();
  const panelId = useId();
  const panelOpen = canvas?.panel?.id === panelId;
  const panelSlot = canvas?.panelSlot?.owner === panelId ? canvas.panelSlot.element : null;
  const speaker = grokSpeaker(author);
  const logOpen = forceOpen || waiting || (!canvas && (userOpen ?? (!live && failedCount > 0)));
  const togglePanel = () => {
    if (!canvas) return setUserOpen(!logOpen);
    if (panelOpen) canvas.close();
    else canvas.openPanel({ id: panelId, label: t("threadTimeline.grokThoughts") });
  };
  const agents = author && (feed.length > 0 || answering || !live)
    ? [{ id: author.id, avatar: <BotFace name={author.name ?? author.slug ?? ""} seed={author.id} face={author.face} className="size-[18px]" /> }]
    : [];
  const block = (
    <section
      data-turn-activity=""
      data-live={live ? "" : undefined}
      data-thinking={rolling ? "" : undefined}
      aria-label={t("threadTimeline.activityFeed")}
      aria-busy={live}
      className={cn("flex w-full min-w-0 max-w-full flex-col self-start", settled && "openedbot-turn-contain")}
    >
      <GrokAgentsHeader
        agents={agents}
        started={start}
        running={running}
        streaming={live && answering}
        seconds={worked !== null ? Math.max(1, Math.round(worked / 1000)) : null}
        pre={pre && feed.length === 0}
        open={canvas ? panelOpen : logOpen}
        onOpen={!canvas || feed.length > 0 ? togglePanel : undefined}
        controls={canvas ? undefined : bodyId}
        // The count only, on the header's line: the error itself reads in the
        // panel, never as raw output squeezed after « Réflexion : Ns ».
        trailing={failedCount > 0 ? (
          <span
            className={cn("ms-1 min-w-0 truncate", partial ? "text-warn-700" : "text-destructive-text")}
            data-tool-partial-failure={partial ? "" : undefined}
          >
            {`• ${partialFailureLabel(t, plural, failedCount, visibleCalls.length)}`}
          </span>
        ) : null}
      />
      <AgentFeed items={feed} running={rolling} renderItem={(item) => <GrokFeedRow item={item} />} />
      <div
        id={bodyId}
        data-open={logOpen ? "true" : "false"}
        className={cn("grid transition-[grid-template-rows] duration-300 motion-reduce:transition-none", logOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
        style={{ transitionTimingFunction: "var(--grok-ease)" }}
      >
        <div className="min-h-0 overflow-hidden" inert={!logOpen} aria-hidden={!logOpen}>
          <div role="list" data-activity-list="" className="openedbot-activity-list flex flex-col gap-0.5 py-1">
            {children}
          </div>
        </div>
      </div>
      {panelSlot && canvas ? createPortal(<GrokThoughtsPanel items={feed} speaker={speaker} onClose={canvas.close} />, panelSlot) : null}
    </section>
  );
  if (!author || !showAuthorLabel) return block;
  const label = author.name ?? author.slug ?? t("threadTimeline.unknownBot");
  return <TurnAuthorHeader author={author} label={label}>{block}</TurnAuthorHeader>;
});
