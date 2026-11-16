import { memo, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { cn } from "@openedbot/browser-ui-kit";
import type { MessageAuthorBot } from "@openedbot/contracts-api";
import type { WebSearchQuery, WebSearchTrail } from "@openedbot/execution/domain/agent-web-search";
import { isTodoTool } from "@openedbot/execution/domain/agent-tool-call";
import type { ToolCall } from "@openedbot/conversation/domain/thread-tools";
import { useT } from "../lib/i18n";
import { toolProgressLabel } from "../lib/run/tool-progress-label";
import { SearchSources } from "./thread-search-sources";
import { partialFailureLabel } from "./thread-tool-labels";
import { BotFace } from "./bot-face";
import type { StreamFeedItem } from "./stream/stream-feed";
import { streamDuration } from "./stream/stream-duration";
import { RunStatusLine, type StreamAgent } from "./stream/run-status-line";
import { StreamThoughtsPanel } from "./stream/stream-thoughts-panel";
import { streamSpeaker } from "./stream/turn-feed";
import { useAttachmentCanvas } from "./attachment-canvas";
import { runStatusPhase, runStatusStep, thinkingAgents } from "../lib/thread/run-thinking-model";
import { prefersReducedMotion, RUN_LINE_MOTION_MS, useRevealOnMount } from "../lib/thread/thread-motion";

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
 * A run's status (`RunStatusLine`) and its folded log. Live, it is the row
 * at the bottom of the turn, under the bot's bubbles, ONE mounted element
 * from the send to the end; a decision to make opens the log under it.
 * Done with work, it is the summary « Réflexion : Ns » on the run's head
 * line, above the reply, which opens the « Réflexions » panel (or, without
 * a canvas, the log folded under it; a failed tool opens it there). At the
 * end of a run seen live, the bottom row collapses (height and opacity,
 * 200 ms) then renders nothing: it never keeps room under the reply. Under
 * `prefers-reduced-motion`, or mounted already finished, it is gone at once.
 */
export const TurnActivity = memo(function TurnActivity({
  runId,
  calls,
  feed = [],
  live,
  pending = false,
  hasWork = true,
  writing = false,
  waiting = false,
  forceOpen,
  author,
  showAuthorLabel,
  children,
  workedMs = null,
  since = null,
  reveal = false,
}: {
  runId?: string;
  calls: readonly ToolCall[];
  /** The run's steps as the panel's rows (`turnFeed`). */
  feed?: readonly StreamFeedItem[];
  live: boolean;
  /** No event yet: the avatar, then the typing dots. */
  pending?: boolean;
  /** The run has work to summarise; without, a finished row collapses and unmounts. */
  hasWork?: boolean;
  /** The run's last entry is a text it is writing. */
  writing?: boolean;
  /** The agent waits for the operator (a pending decision). */
  waiting?: boolean;
  /** A decision is waiting, or the thread's search targets an entry of the log. */
  forceOpen: boolean;
  author: MessageAuthorBot | null;
  /** Done: the bot's name opens the summary line (a 1:1 thread's head line). */
  showAuthorLabel: boolean;
  children?: React.ReactNode;
  /** The run's own duration (created to ended), once it has one. */
  workedMs?: number | null;
  /** The run's real start (epoch ms), for a duration measured here when the run gives none. */
  since?: number | null;
  /** Mounted above a reply already on screen (a summary at the run's end): it opens instead of jumping in. */
  reveal?: boolean;
}) {
  const { t, plural } = useT();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const bodyId = useId();
  const visibleCalls = calls.filter((call) => !isTodoTool(call.tool));
  const failedCount = visibleCalls.filter((call) => call.failed).length;
  const partial = failedCount > 0 && failedCount < visibleCalls.length;
  // Seen ending here from a known start, before the run reports its duration: the row times it.
  const [endedLive, setEndedLive] = useState<{ seen: boolean; ms: number | null }>({ seen: live, ms: null });
  if (live && !endedLive.seen) setEndedLive({ seen: true, ms: null });
  if (!live && endedLive.seen && endedLive.ms === null && since != null) setEndedLive({ seen: true, ms: Math.max(0, Date.now() - since) });
  const durations = visibleCalls.map((call) => call.durationMs).filter((value): value is number => typeof value === "number");
  const totalDuration = durations.length ? durations.reduce((sum, value) => sum + value, 0) : null;
  const worked = workedMs ?? endedLive.ms ?? totalDuration;
  const phase = runStatusPhase({ pending, live, waiting, hasWork });
  const gone = phase === "gone";
  // A row that never ran here (history, a remount) has nothing to collapse.
  const collapseAtOnce = gone && (!endedLive.seen || prefersReducedMotion());
  const [collapsed, setCollapsed] = useState(false);
  if (!gone && collapsed) setCollapsed(false);
  useEffect(() => {
    if (!gone || collapseAtOnce) return;
    const timer = window.setTimeout(() => setCollapsed(true), RUN_LINE_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [gone, collapseAtOnce]);
  const sectionRef = useRef<HTMLElement>(null);
  useRevealOnMount(sectionRef, reveal);
  const canvas = useAttachmentCanvas();
  const panelId = useId();
  const panelOpen = canvas?.panel?.id === panelId;
  const panelSlot = canvas?.panelSlot?.owner === panelId ? canvas.panelSlot.element : null;
  const speaker = streamSpeaker(author);
  const logOpen = forceOpen || waiting || (!canvas && (userOpen ?? (!live && failedCount > 0)));
  const togglePanel = () => {
    if (!canvas) return setUserOpen(!logOpen);
    if (panelOpen) canvas.close();
    else canvas.openPanel({ id: panelId, label: t("threadTimeline.streamThoughts") });
  };
  const step = runStatusStep(calls, { waiting, writing });
  const label = step.kind === "tool"
    ? toolProgressLabel(t, step.call.tool, step.call.preview)
    : step.kind === "waiting"
      ? t("threadTimeline.streamWaiting")
      : step.kind === "writing" ? t("threadTimeline.streamWriting") : t("agentActivity.thinking");
  // No duration to tell (an old turn without one): « Réflexions », never a made-up « 1s ».
  const summary = worked === null
    ? t("threadTimeline.streamThoughts")
    : t("threadTimeline.streamThoughtFor", { duration: streamDuration(Math.max(1, Math.round(worked / 1000))) });
  const { agents, overflow } = rowAgents(author, calls);
  const statusLine = (
    <RunStatusLine
      phase={phase}
      agents={agents}
      overflow={overflow}
      label={label}
      summary={summary}
      open={canvas ? panelOpen : logOpen}
      onOpen={!canvas || feed.length > 0 ? togglePanel : undefined}
      controls={canvas ? undefined : bodyId}
      // The count only, on the row's line: the error itself reads in the
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
  );
  // Done, the summary joins the bot's name on the run's head line, above its reply.
  const named = phase === "done" && showAuthorLabel ? author : null;
  if (gone && (collapseAtOnce || collapsed)) return null;
  const block = (
    <section
      ref={sectionRef}
      data-turn-of={named?.id}
      data-turn-activity=""
      data-run-id={runId}
      // Pending, the row is the thread's thinking status.
      role={pending ? "status" : undefined}
      data-thread-thinking={pending ? "" : undefined}
      data-thinking-status={pending ? "" : undefined}
      data-author={pending ? author?.id : undefined}
      data-live={live ? "" : undefined}
      aria-label={t("threadTimeline.activityFeed")}
      aria-busy={live}
      data-run-reveal={reveal ? "" : undefined}
      data-run-collapsing={gone ? "" : undefined}
      aria-hidden={gone ? true : undefined}
      className={cn("flex w-full min-w-0 max-w-full flex-col self-start", gone && "openedbot-run-status-collapse")}
    >
      {named ? (
        <div data-run-head="" className="flex min-h-6 w-full min-w-0 items-center gap-2">
          <RunAuthorName author={named} />
          <div className="min-w-0 flex-1">{statusLine}</div>
        </div>
      ) : statusLine}
      {children ? (
        <div
          id={bodyId}
          data-open={logOpen ? "true" : "false"}
          className={cn("grid transition-[grid-template-rows] duration-300 motion-reduce:transition-none", logOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
          style={{ transitionTimingFunction: "var(--stream-ease)" }}
        >
          <div className="min-h-0 overflow-hidden" inert={!logOpen} aria-hidden={!logOpen}>
            <div role="list" data-activity-list="" className="openedbot-activity-list flex flex-col gap-0.5 py-1">
              {children}
            </div>
          </div>
        </div>
      ) : null}
      {panelSlot && canvas ? createPortal(<StreamThoughtsPanel runId={runId} items={feed} speaker={speaker} onClose={canvas.close} calls={calls} />, panelSlot) : null}
    </section>
  );
  return block;
});

function RunAuthorName({ author }: { author: MessageAuthorBot }) {
  const { t } = useT();
  const label = author.name ?? author.slug ?? t("threadTimeline.unknownBot");
  return (
    <span data-tool-author="" className="flex min-w-0 shrink-0 items-center gap-2 text-body-2-medium text-text-secondary">
      <span className="flex size-4 shrink-0 items-center justify-center">
        <BotFace name={label} seed={author.id} face={author.face} className="size-5 shrink-0" />
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

/**
 * The run's head line while it works with tools, above its first bubble:
 * the bot's name alone (a 1:1 thread names the bot on a turn with work,
 * never on a plain reply). Once the run is done, its summary takes this
 * place (`TurnActivity`, same height), so « Réflexion : Ns » lands without a
 * shift. Mounted when the first tool starts under a reply already on
 * screen, it opens (`reveal`) instead of jumping in.
 */
export function RunAuthorLine({ author, reveal = false }: { author: MessageAuthorBot; reveal?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useRevealOnMount(ref, reveal);
  return (
    <div
      ref={ref}
      data-run-head=""
      data-turn-of={author.id}
      data-run-reveal={reveal ? "" : undefined}
      className="flex min-h-6 w-full min-w-0 items-center self-start"
    >
      <RunAuthorName author={author} />
    </div>
  );
}

/** The row's avatars: the run's bot and its delegations; the rest is counted as « +N ». */
function rowAgents(author: MessageAuthorBot | null, calls: readonly ToolCall[]): { agents: StreamAgent[]; overflow: number } {
  const { visible, overflow } = thinkingAgents(author, calls);
  const agents: StreamAgent[] = visible.map((agent) => ({
    id: agent.id,
    avatar: <BotFace name={agent.name} seed={agent.seed} face={agent.face} className="size-[1.125rem]" />,
  }));
  return { agents, overflow };
}
