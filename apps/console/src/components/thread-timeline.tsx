import { ThreadInitialLayout } from "./thread-initial-layout";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef } from "react";
import { CircleHelp, ListChecks } from "lucide-react";
import { AgentProgress, TrailItem, type AgentStep } from "@openedbot/browser-ui-kit";
import type { BotSettingProposalDto, MessageAuthorBot } from "@openedbot/contracts-api";
import { isTodoTool } from "@openedbot/execution/domain/agent-tool-call";
import type { ToolCall } from "@openedbot/conversation/domain/thread-tools";
import {
  HANDOFF_NOTICE_KIND,
  splitHandoff,
} from "@openedbot/roster/domain/bot-mode";
import { SUPERSEDED_NOTICE_KIND } from "@openedbot/conversation/domain/followup";
import type { MentionableBot } from "@openedbot/roster/domain/mentions";
import { BotFace } from "./bot-face";
import { BUTTON } from "./settings/primitives";
import { GateCard } from "./gate-card";
import { SettingProposalCard } from "./setting-proposal-card";
import {
  MessageInteractionShell,
  type MessageCardHover,
} from "./message-interactions";
import { usePublishEditAvailability } from "../lib/thread/thread-edit-availability";
import { dismissComposerKeyboardFromThread } from "../lib/composer/composer-keyboard";
import {
  nextThreadPin,
  readThreadScrollBox,
  THREAD_ENTRY_GAP_PX,
  THREAD_MESSAGES_CLASS,
  THREAD_SCROLL_ANCHOR_CLASS,
  THREAD_TURN_CLASS,
} from "../lib/thread/thread-anchor";
import { THREAD_REVEAL_EVENT, type ThreadRevealDetail } from "../lib/thread/thread-reveal";
import { isTimelineTurnStart, THREAD_HISTORY_PAGE_TURNS } from "../lib/thread/thread-virtual";
import { THREAD_ROW_ATTRIBUTE, useThreadVirtualRows } from "../lib/thread/use-thread-virtual-rows";
import { useThreadScrollFollow } from "../lib/thread/use-thread-scroll-follow";
import { useT } from "../lib/i18n";
import { runClockStart, runTimings } from "../lib/run/run-timing";
import { useThreadSpeech } from "../lib/voice/use-thread-speech";
import {
  assistantTextParts,
  createTimelineModelBuilder,
  deriveTimelineWindow,
  entryAskSplit,
  eventText,
  type Entry,
  type TimelineModelBuilder,
} from "../lib/thread/thread-timeline-model";
import { authorRenderKey, entryDayIso, entryRunId, entrySignature } from "../lib/thread/thread-timeline-signature";
import { AssistantAuthor, TurnAuthorHeader } from "./thread-author";
import { RunErrorEntry } from "./thread-run-error";
import { questionsByRun, shownThreadEvents } from "../lib/thread/failed-turns";
import { AssistantMessage, BotInboundMessage, RoomAnswerCard, RoutineStamp, UserMessage } from "./thread-messages";
import { ToolActivity } from "./thread-tool-activity";
import { callsHaveCards, ToolCallCards } from "./cards/run-card-view";
import { PendingThinking } from "./thread-thinking-status";
import { createRunLineTracker, runRows, workRunId, type RunLineTracker, type RunRow } from "../lib/thread/run-thinking-model";
import { ActivityRow, ActivitySearch, RunAuthorLine, TurnActivity } from "./thread-turn-activity";
import { AskUserDismissedMark, DateChip, Divider } from "./thread-timeline-chrome";
import { LiveTimelineEntry } from "./thread-live-entry";
import type { ThreadTimelineProps } from "./thread-timeline-props";
import { AskUserCard } from "./ask-user-card";
import { dismissAskUser } from "../lib/run/ask-user-dismissals";
import { openSecondaryReads, THREAD_FIRST_PAINT_MARK } from "../lib/shell/after-first-paint";
import { streamSpeaker, turnFeed } from "./stream/turn-feed";
import { StreamScrollDown } from "./stream/stream-scroll-down";

/** Stable reference: a `[]` array recreated on every render would break the
 * `memo` of the user bubbles (the mentions `Set` depends on it). */
const EMPTY_MENTIONABLES: MentionableBot[] = [];
const EMPTY_SETTING_PROPOSALS: readonly BotSettingProposalDto[] = [];
const NO_CALLS: readonly ToolCall[] = [];

/**
 * The thread, memoized.
 *
 * Each keystroke in the composer re-renders the conversation screen (the draft
 * lives there); without this `memo`, the thread replayed on every key its full
 * construction (event cards per run, message/run interleaving, sorting of
 * blocks, tool groups): latency visible as soon as a conversation has a
 * bit of history. The `memo` holds only if the screen passes STABLE props:
 * see the `useMemo` / `useCallback` in `conversation.tsx`. The in-flight bubble
 * is a prop of its own (`outgoing`): it must not recreate `userInputs`.
 */
/**
 * A longer silence starts a chip again, at the time of the resume, like
 * The reference app (« Hier 16:41 »): without it, a resume three hours later
 * read as the immediate continuation of the previous message.
 */
export const THREAD_GAP_MS = 60 * 60 * 1000;

function ThreadTimelineView({
  events: allEvents,
  userInputs,
  outgoing = null,
  onRetryOutgoing,
  approvals,
  settingProposals = EMPTY_SETTING_PROPOSALS,
  running,
  mentionables = EMPTY_MENTIONABLES,
  runs = [],
  runAuthors,
  defaultAuthor = null,
  operatorUsername = null,
  activeAskUserRunId = null,
  onAskUserPick,
  activeFindTargetId = null,
  messages = [],
  onReply,
  messageVersionFamilies,
  onEditMessage,
  onRegenerateMessage,
  canEditMessages = true,
  editBlockedReason,
  hiddenAssistantRunIds = "",
  onSelectMessageVersion,
  onReaction,
  speechAdapter: injectedSpeechAdapter,
  speechScope = "thread",
  speechDisabled = false,
  speechVoiceByBotId,
  resnap,
  scrollToBottomOnThreadKey = null,
  /**
   * The cloud API bounded its read (`THREAD_SNAPSHOT_LIMITS`): the start of the thread
   * is not there. A silent ceiling would make this thread read as a complete thread:
   * hence a line, at the head, rather than a silence.
   */
  truncated = false,
  hasOlderHistory = false,
  loadingOlder = false,
  olderError = false,
  onLoadOlder,
  onOpenBotErrors,
  onOpenBotApprovals,
  liveText = null,
}: ThreadTimelineProps) {
  // Without service runs (their `agent.message` formed an empty assistant bubble
  // under the avatar, seen on screen on 04-09), with failed turns made whole.
  const events = useMemo(
    () => shownThreadEvents(allEvents, runs, userInputs, hasOlderHistory),
    [allEvents, runs, userInputs, hasOlderHistory],
  );
  const { t, locale, formatNumber, plural } = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { speechAdapter, speechSettings, speechState, playSpeech } = useThreadSpeech({
    injectedAdapter: injectedSpeechAdapter, speechScope, speechDisabled, locale,
  });
  const { pinned, scrollBox, atBottom, setAtBottom, submissionKeys, outgoingKey } = useThreadScrollFollow({
    scroller,
    content,
    threadKey: scrollToBottomOnThreadKey,
    userInputs,
    outgoing,
    approvalCount: approvals.length,
    resnap,
  });
  /**
   * Cache of React nodes per turn: the key is that of the `nodes` array
   * (`entry.key`, or `activity:${entry.key}` for an activity block). An
   * isolated SSE changes `visible` (new reference), and therefore rebuilds
   * the whole `timelineModel`; without this cache, the render useMemo rebuilt
   * ALL the nodes (markdown, tool logs) on every tick, including
   * those of turns settled long ago, measured at 160-480 ms per tick on
   * a thread of 1401 events. The signature (`entrySignature` +
   * `entryRenderSig`) covers the entry's own fields AND the few
   * context reads that vary per turn (trunk, author label,
   * time…); a turn of which none of that has changed receives EXACTLY the
   * same node as on the previous tick. React then short-circuits its
   * reconciliation on it (comparison by reference, even before `memo`).
   */
  const turnNodeCache = useRef(new Map<string, { sig: string; node: React.ReactNode }>());
  // The runs seen live here: their lines animate at their end instead of keeping room.
  const runLines = useRef<RunLineTracker | null>(null);
  // Edit availability goes through the store (`thread-edit-availability`),
  // outside the turn signatures: its switch re-renders only the message shells.
  usePublishEditAvailability(canEditMessages, editBlockedReason);
  /** Last list of "stable" dependencies seen by the cache above. */
  const contextEpochRef = useRef<unknown[] | null>(null);
  // Stable set (same identity for as long as `mentionables` does not change): otherwise
  // a new reference on every render would break `UserMessage`'s `memo`
  // on every delta of the stream.
  const mentionSlugs = useMemo(
    () => new Set(mentionables.map((bot) => bot.slug)),
    [mentionables],
  );
  const interactionLabels = useMemo(() => ({
    reply: t("threadTimeline.reply"),
    react: t("threadTimeline.react"),
    removeReaction: t("threadTimeline.removeReaction"),
    reactionFailed: t("threadTimeline.reactionFailed"),
    more: t("threadTimeline.moreActions"),
    quoteFrom: (author: string) => t("threadTimeline.quoteFrom", { name: author }),
    operator: t("threadTimeline.operator"),
    assistant: t("threadTimeline.assistant"),
    speak: t("threadTimeline.speak"),
    stopSpeaking: t("threadTimeline.stopSpeaking"),
    speechFailed: t("threadTimeline.speechFailed"),
    copy: t("threadTimeline.copy"),
    copied: t("threadTimeline.copied"),
    copyFailed: t("threadTimeline.copyFailed"),
    copyMessageId: t("threadTimeline.copyMessageId"),
    edit: t("threadTimeline.edit"),
    regenerate: t("threadTimeline.regenerate"),
    previousVersion: t("threadTimeline.previousVersion"),
    nextVersion: t("threadTimeline.nextVersion"),
    versionCount: (current: number, total: number) => t("threadTimeline.versionCount", { current, total }),
  }), [t]);

  const questionByRun = useMemo(() => questionsByRun(userInputs), [userInputs]);

  // A bot's thread: the sent message brings its « Réflexion » line in the same paint, not 70 ms later.
  const outgoingThinks = Boolean(outgoing && !outgoing.failed && defaultAuthor);

  const timelineInput = useMemo(() => ({
    events,
    userInputs,
    messages,
    approvals,
    runs,
    running,
    runAuthors,
    defaultAuthor,
    mentionables,
    operatorUsername,
    activeAskUserRunId,
    toolFallbackLabel: t("eventParts.toolFallback"),
  }), [
    events,
    userInputs,
    messages,
    approvals,
    runs,
    running,
    runAuthors,
    defaultAuthor,
    mentionables,
    operatorUsername,
    activeAskUserRunId,
    t,
  ]);
  const timelineModelBuilder = useRef<TimelineModelBuilder | null>(null);
  const timelineModelBase = useMemo(() => {
    timelineModelBuilder.current ??= createTimelineModelBuilder();
    return timelineModelBuilder.current(timelineInput, { deferDerived: true });
  }, [timelineInput]);

  // Only the turns around the viewport are mounted (`use-thread-virtual-rows.ts`).
  const virtualRows = useThreadVirtualRows({
    scroller,
    entries: timelineModelBase.shown,
    pinned,
    atBottom,
    resetKey: `${speechScope}\u0000${scrollToBottomOnThreadKey ?? ""}`,
    gap: THREAD_ENTRY_GAP_PX,
  });
  const { visible, visibleStart, rowRef, spacers: { top: spacerTop, bottom: spacerBottom } } = virtualRows;
  const timelineModel = useMemo(
    () => deriveTimelineWindow(timelineModelBase, timelineInput, visible, visibleStart),
    [timelineModelBase, timelineInput, visible, visibleStart],
  );
  const {
    shown,
    assistantTurns,
    authorLabelEntryKeys,
    answeredQuestionByUserKey,
    attachedQuestionEntryKeys,
    streamingRunId,
    handoffNoticeByRun,
    runsById,
    trailPositions,
    turnTimeByRun,
  } = timelineModel;
  const visibleRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of visible) {
      const runId = entryRunId(entry);
      if (runId) ids.add(runId);
    }
    return ids;
  }, [visible]);
  // The bot's proposals settle at the end of their run's turn. A
  // proposal whose run is unknown to the thread has no turn to settle in:
  // it closes the thread rather than disappearing.
  const proposalsByRun = useMemo(() => {
    const byRun = new Map<string, BotSettingProposalDto[]>();
    for (const proposal of settingProposals) {
      const list = byRun.get(proposal.runId);
      if (list) list.push(proposal);
      else byRun.set(proposal.runId, [proposal]);
    }
    return byRun;
  }, [settingProposals]);
  // Read event timestamps only from the visible runs' existing model buckets.
  const timingsByRun = useMemo(
    () => runTimings(runs, events, visibleRunIds, timelineModel.eventsByRun, timelineModel.runsById),
    [runs, events, visibleRunIds, timelineModel.eventsByRun, timelineModel.runsById],
  );
  // First messages on screen: the secondary reads of the frame may start
  // (`lib/shell/after-first-paint.ts`). One frame later, so they follow the paint.
  const hasEntries = visible.length > 0;
  useEffect(() => {
    if (!hasEntries) return;
    const frame = requestAnimationFrame(() => {
      // Read by perf passes: when a refresh actually shows its messages.
      if (!performance.getEntriesByName(THREAD_FIRST_PAINT_MARK).length) performance.mark(THREAD_FIRST_PAINT_MARK);
      openSecondaryReads();
    });
    return () => cancelAnimationFrame(frame);
  }, [hasEntries]);
  const showOlder = hasOlderHistory;
  // A day chip opens a day of the THREAD, not of the mounted rows: the oldest
  // turn mounted only gets one when the turn before it is from another day.
  // The same holds for a gap chip: the hidden turn's instant is the one the
  // first mounted turn is measured against.
  const isoBeforeWindow = useMemo(() => {
    for (let index = visibleStart - 1; index >= 0; index -= 1) {
      const iso = entryDayIso(shown[index]!, turnTimeByRun);
      if (iso) return iso;
    }
    return null;
  }, [shown, visibleStart, turnTimeByRun]);

  // The turn rail, the search in the thread and the global search
  // ask for a target (`THREAD_REVEAL_EVENT`): mounted if it is not,
  // then the thread settles on it. `revealTarget` reads the turns by ref: the listener does not
  // resubscribe on every SSE.
  const { revealTarget } = virtualRows;
  useEffect(() => {
    const onReveal = (event: Event) => {
      const detail = (event as CustomEvent<ThreadRevealDetail>).detail;
      const targetId = detail?.targetId;
      if (!targetId) return;
      const mounted = scroller.current?.querySelector<HTMLElement>(
        `[data-thread-find-target="${CSS.escape(targetId)}"]`,
      );
      if (!mounted && !revealTarget(targetId, detail.block)) return;
      pinned.current = false;
      setAtBottom(false);
      // Already mounted: settled at once, with no animation by default (an
      // animation passes back through the « en bas » zone and could stick the thread there again).
      mounted?.scrollIntoView({ block: detail.block ?? "start", behavior: detail.behavior ?? "auto" });
    };
    document.addEventListener(THREAD_REVEAL_EVENT, onReveal);
    return () => document.removeEventListener(THREAD_REVEAL_EVENT, onReveal);
  }, [revealTarget]);

  const withTurnAuthor = useCallback((entryKey: string, runId: string, content: React.ReactNode): React.ReactNode => {
    const trail = trailPositions.get(entryKey);
    // The trunk starts from the block's glyph, never from the bot's face: it settles
    // IN the header's reply, not around it.
    const body = trail
      ? <TrailItem key={entryKey} position={trail} gap={THREAD_ENTRY_GAP_PX}>{content}</TrailItem>
      : content;
    const author = authorLabelEntryKeys.has(entryKey) ? runAuthors?.get(runId) ?? defaultAuthor : null;
    if (!author) return body;
    const label = author.name ?? author.slug ?? t("threadTimeline.unknownBot");
    return <TurnAuthorHeader key={entryKey} author={author} label={label}>{body}</TurnAuthorHeader>;
  }, [authorLabelEntryKeys, runAuthors, defaultAuthor, t, trailPositions]);

  const shouldAutoRead = !speechDisabled && speechSettings.autoRead;
  const speakableAssistants = useMemo(() => {
    if (!shouldAutoRead) return [];
    return shown.flatMap((entry) => {
      if (entry.kind !== "assistant" || entry.runId === streamingRunId) return [];
      const { shown: shownText, body, handoff } = assistantTextParts(
        entry,
        operatorUsername,
        handoffNoticeByRun.get(entry.runId) ?? null,
        mentionables,
      );
      const text = handoff ? body : shownText;
      const author = entry.author ?? defaultAuthor;
      return text.trim() ? [{
        id: entry.key,
        text,
        voiceId: author ? speechVoiceByBotId?.get(author.id) ?? null : null,
        botId: author?.id ?? null,
      }] : [];
    });
  }, [
    shouldAutoRead,
    shown,
    streamingRunId,
    operatorUsername,
    handoffNoticeByRun,
    mentionables,
    defaultAuthor,
    speechVoiceByBotId,
  ]);
  const speakableSignature = useMemo(
    () => speakableAssistants.map((item) => `${item.id}:${item.voiceId ?? ""}:${item.text}`).join("\u0000"),
    [speakableAssistants],
  );
  const autoReadSeen = useRef(new Set<string>());
  const autoReadScope = useRef<string | null>(null);
  const autoReadReady = useRef(false);

  useEffect(() => {
    if (!shouldAutoRead) {
      autoReadReady.current = false;
      return;
    }
    const ids = speakableAssistants.map((item) => item.id);
    if (autoReadScope.current !== speechScope || !autoReadReady.current) {
      autoReadScope.current = speechScope;
      autoReadSeen.current = new Set(ids);
      autoReadReady.current = true;
      return;
    }
    const fresh = speakableAssistants.filter((item) => !autoReadSeen.current.has(item.id));
    ids.forEach((id) => autoReadSeen.current.add(id));
    if (fresh.length) {
      const latest = fresh.at(-1)!;
      playSpeech(latest.id, latest.text, latest.voiceId, latest.botId);
    }
  }, [playSpeech, speakableSignature, shouldAutoRead, speechScope]);

  // Each turn's tool failures: a closed plan must not read as
  // « sans accroc » when a tool of the same run has failed.
  const toolFailuresByRun = useMemo(() => {
    const failures = new Map<string, number>();
    for (const entry of visible) {
      if (entry.kind !== "tools") continue;
      const count = entry.calls.filter((call) => !isTodoTool(call.tool) && call.failed).length;
      if (count > 0) failures.set(entry.runId, (failures.get(entry.runId) ?? 0) + count);
    }
    return failures;
  }, [visible]);

  return (
    <ThreadInitialLayout threadKey={scrollToBottomOnThreadKey}>
    <div
      ref={scroller}
      // A scrolling region must stay reachable from the keyboard: without
      // `tabIndex`, the transcript cannot be walked without a mouse
      // (axe: `scrollable-region-focusable`).
      tabIndex={0}
      role="log"
      aria-label={t("threadTimeline.transcriptLabel")}
      className="openedbot-thread-scroll-contain bui-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-2 pb-4 outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-inset"
      onPointerDown={(event) => {
        if (!event.currentTarget.closest("[data-mobile-shell]")) return;
        dismissComposerKeyboardFromThread(event);
      }}
      onScroll={() => {
        const node = scroller.current;
        if (!node) return;
        const next = readThreadScrollBox(node);
        const stay = nextThreadPin(scrollBox.current, next, pinned.current);
        pinned.current = stay;
        setAtBottom((prev) => (prev === stay ? prev : stay));
        scrollBox.current = next;
        virtualRows.onScroll();
      }}
    >
      <div ref={content} data-thread-messages="" className={THREAD_MESSAGES_CLASS}>
        {truncated && !hasOlderHistory ? (
          <p className="py-2 text-center text-xs text-muted-foreground">
            {t("threadTimeline.truncatedNotice")}
          </p>
        ) : null}
        {showOlder ? (
          <button
            type="button"
            className={`${BUTTON.secondary} mx-auto my-1`}
            disabled={loadingOlder}
            aria-busy={loadingOlder}
            onClick={() => {
              // The turns read now stay under the eyes: the older page lands
              // above them, and the anchor absorbs its height.
              pinned.current = false;
              setAtBottom(false);
              virtualRows.captureAnchor();
              void onLoadOlder?.();
            }}
          >
            {loadingOlder ? t("threadTimeline.loadingEarlier") : t("threadTimeline.loadEarlier", { count: THREAD_HISTORY_PAGE_TURNS })}
          </button>
        ) : null}
        {olderError ? <p role="alert" className="py-2 text-center text-xs text-destructive-text">{t("threadTimeline.earlierLoadFailed")}</p> : null}
        {[...useMemo(() => {
        const renderEntry = (
          entry: Entry,
          inActivity = false,
        ): React.ReactNode => {
          // In the activity block, the author header and the trace trunk
          // belong to the block, not to each of its entries.
          const wrapTurn = (key: string, runId: string, node: React.ReactNode) =>
            inActivity ? node : withTurnAuthor(key, runId, node);
          if (entry.kind === "routine") return <RoutineStamp key={entry.key} at={entry.createdAt} />;
          if (entry.kind === "user")
            return (
              <MessageInteractionShell
                key={entry.key}
                messageId={entry.key}
                replyTo={entry.replyTo}
                reactions={entry.reactions}
                align={entry.authorBot ? "start" : "end"}
                actions="menu"
                context={!entry.authorBot && answeredQuestionByUserKey.has(entry.key) ? (
                  <p
                    data-answered-question=""
                    className="flex max-w-full items-start justify-end gap-1.5 self-end px-1 text-right text-xs italic text-muted-foreground"
                  >
                    <CircleHelp aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    <span className="wrap-anywhere">{answeredQuestionByUserKey.get(entry.key)}</span>
                  </p>
                ) : undefined}
                labels={interactionLabels}
                copyText={entry.text}
                onReply={onReply}
                onReaction={onReaction}
                versionFamily={!entry.authorBot ? messageVersionFamilies?.get(entry.key) ?? null : null}
                onEdit={!entry.authorBot ? onEditMessage : undefined}
                onRegenerate={!entry.authorBot ? onRegenerateMessage : undefined}
                onSelectVersion={!entry.authorBot ? onSelectMessageVersion : undefined}
              >
                {entry.authorBot ? (
                  <BotInboundMessage
                    text={entry.text}
                    authorBot={entry.authorBot}
                    findTargetId={entry.targetId}
                    findActive={entry.targetId === activeFindTargetId}
                  />
                ) : (
                  <UserMessage
                    text={entry.text}
                    attachments={entry.attachments}
                    steeredIntoActive={entry.steeredIntoActive}
                    steeredIntoSettled={entry.steeredIntoSettled}
                    mentionSlugs={mentionSlugs}
                    findTargetId={entry.targetId}
                    findActive={entry.targetId === activeFindTargetId}
                    onEdit={onEditMessage ? () => onEditMessage(entry.key) : undefined}
                  />
                )}
              </MessageInteractionShell>
            );
          if (entry.kind === "assistant") {
            // The plan card carries this prose. Leaving it in a bubble
            // would double the reply under the dock.
            if (hiddenAssistantRunIds.length > 0 && hiddenAssistantRunIds.split(",").includes(entry.runId)) {
              return null;
            }
            // The bubble keeps the prose; the terminal question belongs to the
            // panel (the active run) or folds into one line (the history).
            // Never the raw `@handle` block + chips: that is plumbing.
            // Filtering of the `remember:` lines went away with the regime
            // of openedbot memory (07-09): nothing produces them or
            // consumes them anymore, what the bot retains lives in its Hermes store.
            const visible = entry.text;
            const split = entryAskSplit(entry, operatorUsername);
            const live = entry.runId === activeAskUserRunId;
            const questionAttachedToAnswer = attachedQuestionEntryKeys.has(entry.key);
            const shown = split.prompt ? split.body : visible;
            // The same rule for the hand-off directive `@slug …`: as soon as a
            // notice explains it, the raw line leaves the bubble. Transmitted,
            // it folds into « → transmis à 🤖 X »; REFUSED, it disappears
            // : nothing left, and the refusal notice already says why in
            // the thread. The split applies to the MERGED text: during
            // streaming the line may appear for a moment, but the notice
            // arrives with the end of the turn: it never stays raw once
            // the run is concluded.
            const handoffNotice = handoffNoticeByRun.get(entry.runId) ?? null;
            const { body, handoff } = handoffNotice
              ? splitHandoff(
                  shown,
                  handoffNotice.target ? [...mentionables, handoffNotice.target] : mentionables,
                )
              : { body: shown, handoff: null };
            const relayed = handoffNotice?.outcome === "relayed" && !handoffNotice.childRunId ? handoff : null;
            const publicText = handoff ? body : shown;
            const turn = assistantTurns.get(entry.runId);
            const turnStart = !turn || turn.firstKey === entry.key;
            // Copy, read and react wait for the end of the run: for as long as it
            // is running, other tools can still settle under this
            // fragment, and the bar ended up in the middle of the turn.
            const turnRun = runsById.get(entry.runId);
            const turnLive = running && turnRun !== undefined &&
              turnRun.status !== "completed" && turnRun.status !== "failed" && turnRun.status !== "cancelled";
            const turnEnd = (!turn || turn.lastKey === entry.key) && !turnLive;
            const turnText = turn?.text || publicText;
            const cardHover: MessageCardHover = {
              messageId: entry.messageId,
              copyText: turnText,
              reactions: turnEnd ? entry.reactions : [],
              labels: interactionLabels,
              onReply,
              onReaction,
              speakerFor: !speechDisabled && speechAdapter.supported && entry.runId !== streamingRunId
                ? (cardId, text) => {
                    const speechId = `${entry.key}:${cardId}`;
                    return {
                      status: speechState.id === speechId ? speechState.status : "idle",
                      onToggle: () => {
                        const author = entry.author ?? defaultAuthor;
                        playSpeech(
                          speechId,
                          text,
                          author ? speechVoiceByBotId?.get(author.id) ?? null : null,
                          author?.id ?? null,
                        );
                      },
                    };
                  }
                : undefined,
            };
            return (
              <Fragment key={entry.key}>
                {body.trim() || (!split.prompt && !handoff) ? (
                  <MessageInteractionShell
                    surface="chrome"
                    messageId={entry.messageId}
                    replyTo={turnStart ? entry.replyTo : null}
                    reactions={turnEnd ? entry.reactions : []}
                    align="start"
                    labels={interactionLabels}
                    copyText={turnEnd ? turnText : null}
                    onReply={onReply}
                    onReaction={onReaction}
                    speaker={turnEnd ? cardHover.speakerFor?.("response", turnText) : undefined}
                  >
                    <AssistantMessage
                      runId={entry.runId}
                      text={publicText}
                      attachments={entry.attachments}
                      author={entry.author ?? defaultAuthor}
                      streaming={entry.runId === streamingRunId}
                      timing={turnEnd ? timingsByRun.get(entry.runId) ?? null : null}
                      findTargetId={entry.messageId ? `message:${entry.messageId}` : entry.targetId}
                      findActive={(entry.messageId ? `message:${entry.messageId}` : entry.targetId) === activeFindTargetId}
                      hover={turnEnd ? cardHover : undefined}
                      />
                  </MessageInteractionShell>
                ) : null}
                {relayed ? (
                  // The transmitted instruction folds by default: the line says
                  // TO WHOM, the unfold says WHAT: the message already lives at the
                  // target, the origin bubble does not have to shout it twice.
                  // A refusal does not have this line: nothing was transmitted, and
                  // announcing a target would lie about what happened.
                  <details
                    className="self-start px-1 text-xs text-muted-foreground"
                    data-handoff={relayed.slug}
                    data-thread-find-target={`run:${entry.runId}`}
                  >
                    <summary className="cursor-pointer list-none italic">
                      {t("threadTimeline.handoffRelayed", { name: relayed.name })}
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap wrap-anywhere border-l-2 border-border/60 pl-2 italic">
                      {relayed.message}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-2">
                      <a
                        href={`/c/${relayed.slug}?focus=run:${entry.runId}`}
                        className="text-foreground underline-offset-2 hover:underline"
                      >
                        {t("threadTimeline.handoffOpenTarget", { name: relayed.name })}
                      </a>
                      {(() => {
                        const notice = events.find((event) =>
                          event.runId === entry.runId
                          && event.type === "system.notice"
                          && event.payload.kind === HANDOFF_NOTICE_KIND.sent,
                        );
                        const workflowId = runs.find((run) => run.id === entry.runId)?.workflowId;
                        const tokens = runs
                          .filter((run) => run.workflowId && run.workflowId === workflowId && run.stepKind === "delegated")
                          .reduce((sum, run) => sum + (run.usage?.totalTokens ?? 0), 0);
                        return tokens > 0 ? (
                          <span className="tabular-nums">
                            {t("threadTimeline.handoffTokens", { count: formatNumber(tokens) })}
                          </span>
                        ) : notice ? null : null;
                      })()}
                    </p>
                  </details>
                ) : null}
                {split.prompt && live && onAskUserPick ? (
                  <AskUserCard prompt={split.prompt} onPick={onAskUserPick} onDismiss={() => dismissAskUser(entry.runId)} />
                ) : null}
                {split.prompt && !live && !questionAttachedToAnswer ? (
                  <p className="flex items-baseline gap-1.5 self-start px-1 text-xs italic text-muted-foreground">
                    <CircleHelp aria-hidden className="size-3.5 shrink-0 translate-y-0.5" />
                    {split.prompt.question}
                    <AskUserDismissedMark runId={entry.runId} />
                  </p>
                ) : null}
              </Fragment>
            );
          }
          if (entry.kind === "plan") {
            const steps: AgentStep[] = entry.plan.steps.map((step) => ({
              id: step.id,
              label: step.content,
              status: step.status === "completed"
                ? "done"
                : step.status === "in_progress"
                  ? "active"
                  : step.status === "cancelled"
                    ? "cancelled"
                    : "pending",
            } satisfies AgentStep));
            return wrapTurn(entry.key, entry.runId, (
              <AgentProgress
                key={entry.key}
                title={t("agentActivity.planTitle")}
                completedTitle={(() => {
                  const failures = toolFailuresByRun.get(entry.runId) ?? 0;
                  return failures > 0
                    ? plural(failures, {
                        one: t("agentActivity.planCompletedWithFailures_one", { count: failures }),
                        other: t("agentActivity.planCompletedWithFailures_other", { count: failures }),
                      })
                    : t("agentActivity.planCompleted");
                })()}
                completedTone={toolFailuresByRun.has(entry.runId) ? "warn" : "neutral"}
                remainingLabel={(remaining) =>
                  plural(remaining, {
                    one: t("agentActivity.planRemaining_one", { count: remaining }),
                    other: t("agentActivity.planRemaining_other", { count: remaining }),
                  })}
                expandLabel={t("agentActivity.planExpand")}
                collapseLabel={t("agentActivity.planCollapse")}
                steps={steps}
                icon={<ListChecks aria-hidden className="size-3.5 shrink-0" />}
                defaultCollapsed={runsById.get(entry.runId)?.status === "completed"}
                className="self-start"
              />
            ));
          }
          if (entry.kind === "search") {
            // Rows of the Agent Activity feed: one per query, its results
            // under it. The turn's block folds them once the turn concludes.
            const rows = <ActivitySearch key={entry.key} trail={entry.trail} />;
            return inActivity ? rows : wrapTurn(entry.key, entry.runId, (
              <div key={entry.key} role="list" className="flex w-full min-w-0 max-w-full flex-col self-start">{rows}</div>
            ));
          }
          if (entry.kind === "gate") {
            const trail = inActivity ? undefined : trailPositions.get(entry.key);
            const card = <GateCard key={entry.key} approval={entry.approval} mode="summary" />;
            return trail
              ? <TrailItem key={entry.key} position={trail} gap={THREAD_ENTRY_GAP_PX}>{card}</TrailItem>
              : card;
          }
          if (entry.kind === "tools") {
            // Tool Result rows of the turn's Agent Activity feed. A tools
            // entry outside a feed only holds `todo` calls (the plan card
            // tells them) and renders nothing.
            if (entry.approvals.length === 0 && entry.calls.every((call) => isTodoTool(call.tool))) return null;
            const activity = (
              <ToolActivity
                key={entry.key}
                entryKey={entry.key}
                calls={entry.calls}
                searches={entry.searches}
                approvals={entry.approvals}
                findTargetId={entry.targetId}
                findActive={entry.targetId === activeFindTargetId}
                onSeeBotErrors={onOpenBotErrors}
              />
            );
            return inActivity ? activity : wrapTurn(entry.key, entry.runId, (
              <div key={entry.key} role="list" className="flex w-full min-w-0 max-w-full flex-col self-start">{activity}</div>
            ));
          }

          const { event } = entry;
          switch (event.type) {
            case "run.error":
              return (
                <RunErrorEntry
                  key={entry.key}
                  event={event}
                  run={runsById.get(event.runId)}
                  author={runAuthors?.get(event.runId) ?? defaultAuthor}
                  question={questionByRun.get(event.runId)}
                  onRegenerate={onRegenerateMessage}
                  onPermissions={onOpenBotApprovals}
                  findTargetId={entry.targetId}
                  findActive={entry.targetId === activeFindTargetId}
                />
              );
            case "run.provider_fallback": {
              const from = typeof event.payload.from === "string" ? event.payload.from : "-";
              const to = typeof event.payload.to === "string" ? event.payload.to : "-";
              const model = typeof event.payload.model === "string" ? event.payload.model : "-";
              return (
                <Divider key={entry.key} findTargetId={entry.targetId} findActive={entry.targetId === activeFindTargetId}>
                  {t("threadTimeline.providerFallback", { from, to, model })}
                </Divider>
              );
            }
            case "system.notice": {
              // Aligned with Hermes-Bot-Mode: silence stays silent. The
              // `group.pass` notice only serves to hide the streamed text
              // (`passedRuns` above). « Le salon se calme. » is no longer emitted;
              // earlier threads keep theirs in the database, it is no longer rendered.
              if (event.payload.kind === "group.pass" || event.payload.kind === SUPERSEDED_NOTICE_KIND) return null;
              if (event.payload.kind === "group.settled" && eventText(event) === "Le salon se calme.") return null;
              // The notices of the old openedbot memory (`memory.fact`, `memory.full`)
              // stay in the threads from before 07-09: they are no longer rendered.
              if (event.payload.kind === "memory.fact" || event.payload.kind === "memory.full") return null;
              const receiptRunId = typeof event.payload.childRunId === "string"
                ? event.payload.childRunId
                : typeof event.payload.continuationRunId === "string" ? event.payload.continuationRunId : null;
              if (receiptRunId) {
                const targetBotId = typeof event.payload.targetBotId === "string" ? event.payload.targetBotId : null;
                const author = runAuthors?.get(receiptRunId)
                  ?? (defaultAuthor?.id === targetBotId ? defaultAuthor : null);
                const slug = typeof event.payload.targetSlug === "string" ? event.payload.targetSlug : author?.slug;
                const name = typeof event.payload.targetName === "string" ? event.payload.targetName : author?.name;
                const label = slug ? `@${slug}` : name ?? "bot";
                return (
                  <a
                    key={entry.key}
                    href={`?focus=run:${receiptRunId}`}
                    data-coordination-run={receiptRunId}
                    data-thread-find-target={entry.targetId}
                    className="flex self-start items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <BotFace name={name ?? label} seed={targetBotId ?? receiptRunId} face={author?.face} className="size-6 shrink-0" />
                    {t(event.payload.childRunId ? "threadTimeline.coordinationSent" : "threadTimeline.coordinationResumed", { name: label })}
                  </a>
                );
              }
              if (event.payload.kind === HANDOFF_NOTICE_KIND.received) {
                const href = typeof event.payload.href === "string" ? event.payload.href : null;
                return (
                  <Divider key={entry.key} findTargetId={entry.targetId} findActive={entry.targetId === activeFindTargetId}>
                    {href ? (
                      <a href={href} className="text-foreground underline-offset-2 hover:underline">
                        {t("threadTimeline.handoffReceived")}
                      </a>
                    ) : t("threadTimeline.handoffReceived")}
                  </Divider>
                );
              }
              const text = eventText(event);
              return <Divider key={entry.key} findTargetId={entry.targetId} findActive={entry.targetId === activeFindTargetId}>{text}</Divider>;
            }
            case "approval.responded":
              // The gate itself (`GateCard`) already carries the decision made:
              // a redundant divider after every validation cluttered the thread.
              return null;
            case "bot.message":
              // A reread signal only: the line is shown via `messages` (BotInboundMessage above).
              return null;
            default:
              // `tool.result`, `tool.result.attached`, `approval.requested`,
              // `raw`, `run.completed`: either already rendered elsewhere (the line
              // `ToolActivity` of the matching call, for the first two),
              // or with no display value of their own.
              return null;
          }
        };
        // Each run's last entry, its user message included: proposals and the live tail read it.
        const lastEntryIndex = new Map<string, number>();
        visible.forEach((entry, index) => {
          const runId = entryRunId(entry);
          if (runId) lastEntryIndex.set(runId, index);
        });
        // The reply the live run is still writing: only its bubble reads the text in progress (`LiveTimelineEntry`).
        const liveTail = streamingRunId === null ? undefined : visible[lastEntryIndex.get(streamingRunId) ?? -1];
        const liveTailKey = liveTail?.kind === "assistant" ? liveTail.key : null;
        // Before its first event, the live run is the latest one still active
        // (a sent bubble hosts its own pending row meanwhile).
        let activeRunId: string | null = null;
        let activeSince: number | null = null;
        if (running) {
          for (const candidate of runsById.values()) {
            if (candidate.status === "completed" || candidate.status === "failed" || candidate.status === "cancelled") continue;
            const created = runClockStart(candidate);
            if (Number.isFinite(created) && (activeSince === null || created > activeSince)) {
              activeSince = created;
              activeRunId = candidate.id;
            }
          }
        }
        const liveRunId = streamingRunId ?? (running && !outgoingThinks ? activeRunId : null);
        // One status row per run (`runRows`): its work folds into it, its texts stay bubbles.
        // A run that just ended keeps its bottom row for its collapse, then nothing.
        runLines.current ??= createRunLineTracker();
        const lines = runLines.current;
        const linesNow = Date.now();
        const closing = lines.observe(liveRunId, linesNow);
        const rowsByRun = runRows(visible, { liveRunId, closing });
        // The transmitted token count (the « relayed » block) rereads `events`/`runs`
        // in full: including them in the cache signature would empty the
        // cache on EVERY SSE tick. This case stays rare (a hand-off directive
        // that was transmitted), it is simply taken out of the cache rather than
        // paying that cost for every turn.
        const skipsCache = (entry: Entry): boolean =>
          entry.kind === "assistant" && handoffNoticeByRun.get(entry.runId)?.outcome === "relayed";
        // An entry's render signature: its own fields
        // (`entrySignature`) + the context reads that vary per turn
        // (trunk, author label, time, answered question, aggregated turn
        // of a run in several fragments…). Everything else (i18n labels,
        // callbacks, active search target…) is stable from one SSE tick to
        // the next; a change there empties the whole cache via `contextEpoch`
        // below rather than being recomputed here for every turn.
        const entryRenderSig = (entry: Entry): string => {
          const runId = entryRunId(entry);
          // `running`/`streamingRunId` change on EVERY
          // run start or end: putting them in `contextEpochDeps`
          // (global context) would empty the whole cache at that moment, measured
          // at 458-507 ms. They in fact affect only the turn concerned (a
          // past run keeps a terminal status whatever `running` is): their
          // EFFECT is therefore read here, per turn. Whether editing is allowed goes
          // through the `thread-edit-availability` store, outside the signature.
          const turnRun = runId ? runsById.get(runId) : undefined;
          const turnLive = entry.kind === "assistant" && running && turnRun !== undefined &&
            turnRun.status !== "completed" && turnRun.status !== "failed" && turnRun.status !== "cancelled";
          const ctx = {
            trail: trailPositions.get(entry.key) ?? null,
            labeled: authorLabelEntryKeys.has(entry.key),
            time: entry.kind === "user"
              ? entry.createdAt ?? null
              : runId
                ? turnTimeByRun.get(runId) ?? null
                : null,
            answered: entry.kind === "user" ? answeredQuestionByUserKey.get(entry.key) ?? null : null,
            attachedQuestion: entry.kind === "assistant" ? attachedQuestionEntryKeys.has(entry.key) : false,
            askLive: entry.kind === "assistant" && entry.runId === activeAskUserRunId,
            streaming: entry.kind === "assistant" && entry.runId === streamingRunId,
            turnLive,
            routineId: turnRun?.routineId ?? null,
            turnText: entry.kind === "assistant" ? assistantTurns.get(entry.runId)?.text ?? "" : null,
            toolFailures: entry.kind === "plan" ? toolFailuresByRun.get(entry.runId) ?? 0 : null,
            runStatus: entry.kind === "plan" || entry.kind === "search"
              ? runsById.get(entry.runId)?.status ?? null
              : null,
            // `runAuthors`, `messageVersionFamilies` and `speechVoiceByBotId`
            // are Maps recreated on every added run or patched roster:
            // in the global context they emptied the whole cache on a 202 (measured
            // at 343 ms). Only the value read by THIS turn counts.
            author: runId ? authorRenderKey(runAuthors?.get(runId) ?? defaultAuthor) : null,
            voice: runId ? speechVoiceByBotId?.get((runAuthors?.get(runId) ?? defaultAuthor)?.id ?? "") ?? null : null,
            version: entry.kind === "user" ? messageVersionFamilies?.get(entry.key) ?? null : null,
            planHidden: entry.kind === "assistant" && hiddenAssistantRunIds.length > 0
              && hiddenAssistantRunIds.split(",").includes(entry.runId),
            // A failed turn: its run's code can land after the event, its question names and replays it.
            failure: entry.kind === "event" && entry.event.type === "run.error"
              ? [turnRun?.errorCode ?? null, questionByRun.get(entry.event.runId)?.id ?? null]
              : null,
          };
          return `${entrySignature(entry)}${JSON.stringify(ctx)}`;
        };
        // Context STABLE from one SSE tick to the next (props, callbacks, settings),
        // never the Maps rebuilt on every pass of `timelineModel`, nor
        // the flags that vary per run (read per turn above). A
        // reference difference here is rare (language, search target,
        // voice switch) and empties the whole cache. The screens therefore pass
        // callbacks of stable identity (reads by ref, no dependency
        // on the thread's data): otherwise every 202 re-renders the whole thread.
        // Mentions by their CONTENT: `mentionables` is recomputed on every
        // roster patch (202, stream) without the mentionable bots changing.
        const mentionKey = mentionables
          .map((candidate) => `${candidate.id}:${candidate.slug}:${authorRenderKey(candidate)}`)
          .join("|");
        // The default author is rebuilt on every roster patch. The content key
        // (id, name, slug, face) keeps the turns' cache for as long as
        // this author has not really changed (DEV-218).
        const defaultAuthorKey = authorRenderKey(defaultAuthor);
        const contextEpochDeps = [
          interactionLabels, onReply, onReaction, onEditMessage, onRegenerateMessage, onAskUserPick,
          onSelectMessageVersion, onOpenBotApprovals, mentionKey, activeFindTargetId,
          defaultAuthorKey, operatorUsername, speechDisabled,
          speechAdapter, speechState, playSpeech, t, plural, formatNumber,
        ];
        const previousEpochDeps = contextEpochRef.current;
        const contextChanged = previousEpochDeps === null
          || previousEpochDeps.length !== contextEpochDeps.length
          || contextEpochDeps.some((dep, depIndex) => dep !== previousEpochDeps[depIndex]);
        contextEpochRef.current = contextEpochDeps;
        const nodeCache = turnNodeCache.current;
        if (contextChanged) nodeCache.clear();
        const liveCacheKeys = new Set<string>();
        const cached = (cacheKey: string, sig: string, build: () => React.ReactNode): React.ReactNode => {
          liveCacheKeys.add(cacheKey);
          const hit = nodeCache.get(cacheKey);
          if (hit && hit.sig === sig) return hit.node;
          const node = build();
          nodeCache.set(cacheKey, { sig, node });
          return node;
        };
        const renderCached = (entry: Entry): React.ReactNode => {
          const build = (live: typeof liveText) => entry.kind !== "assistant" ? renderEntry(entry, false)
            : <LiveTimelineEntry key={entry.key} entry={entry} live={live} render={(full) => renderEntry(full, false)} />;
          // The live reply follows the snapshot on every render: outside the cache.
          if (entry.key === liveTailKey) return build(liveText);
          return skipsCache(entry) ? build(null) : cached(entry.key, entryRenderSig(entry), () => build(null));
        };

        // One row per turn (`data-thread-turn`, measured by the virtual rows);
        // what follows the last turn (orphan proposals, the thinking status)
        // comes after the bottom spacer, at the end of the thread.
        const rows: { key: string; nodes: React.ReactNode[] }[] = [];
        const trailing: React.ReactNode[] = [];
        let nodes = trailing;
        // The card depends on the proposal alone (not on the callbacks nor the
        // context's labels): it lives in the per-turn cache with its own
        // signature, never in `contextEpochDeps`.
        const proposalNode = (proposal: BotSettingProposalDto): React.ReactNode =>
          cached(
            `proposal:${proposal.id}`,
            JSON.stringify([proposal.status, proposal.hash, proposal.reason, proposal.resolvedAt]),
            () => <SettingProposalCard key={`proposal:${proposal.id}`} proposal={proposal} botId={proposal.botId} />,
          );
        // Salon: the consecutive replies of several members form ONE
        // team card. The wrapped nodes stay those of the per-turn cache.
        // In team mode, the synthesis goes to the head. The contributions
        // open underneath, each signed by its bot.
        let room: {
          key: string;
          authors: MessageAuthorBot[];
          contributions: { author: MessageAuthorBot; node: React.ReactNode }[];
          synthesis: React.ReactNode[];
        } | null = null;
        const flushRoom = () => {
          if (!room) return;
          const authors = room.authors.filter((author, index, all) => all.findIndex((other) => other.id === author.id) === index);
          if (authors.length >= 2) {
            nodes.push(
              <RoomAnswerCard key={`room:${room.key}`} authors={authors} synthesis={room.synthesis.length ? room.synthesis : null}>
                {room.contributions.map((item, index) => (
                  <div key={`${item.author.id}:${index}`} data-room-contribution="" className="flex min-w-0 flex-col">
                    <AssistantAuthor
                      author={item.author}
                      label={item.author.name ?? item.author.slug ?? t("threadTimeline.unknownBot")}
                    />
                    {item.node}
                  </div>
                ))}
              </RoomAnswerCard>,
            );
          } else {
            nodes.push(...room.contributions.map((item) => item.node), ...room.synthesis);
          }
          room = null;
        };
        const pushNode = (node: React.ReactNode, entry?: Entry) => {
          if (entry?.kind === "assistant" && entry.author) {
            room ??= { key: entry.key, authors: [], contributions: [], synthesis: [] };
            room.authors.push(entry.author);
            if (runsById.get(entry.runId)?.groupPhase === "synthesis") room.synthesis.push(node);
            else room.contributions.push({ author: entry.author, node });
            return;
          }
          flushRoom();
          nodes.push(node);
        };
        // BoardUI template: a date chip opens each day of the thread, and
        // a resume after a long silence (`THREAD_GAP_MS`).
        let lastDay: string | null = isoBeforeWindow ? new Date(isoBeforeWindow).toDateString() : null;
        let lastAt: number | null = isoBeforeWindow ? new Date(isoBeforeWindow).getTime() : null;
        const pushDay = (entry: Entry) => {
          const iso = entryDayIso(entry, turnTimeByRun);
          if (!iso) return;
          const date = new Date(iso);
          const at = date.getTime();
          if (Number.isNaN(at)) return;
          const day = date.toDateString();
          const gap = lastAt !== null && at - lastAt >= THREAD_GAP_MS;
          lastAt = Math.max(lastAt ?? at, at);
          if (day === lastDay && !gap) return;
          lastDay = day;
          pushNode(<DateChip key={`day:${day}:${at}`} iso={iso} />);
        };
        // Proposal cards follow the LAST visible entry of their run.
        const pushProposalsAfter = (endIndex: number) => {
          const endRunId = endIndex >= 0 ? entryRunId(visible[endIndex]!) : null;
          if (!endRunId || lastEntryIndex.get(endRunId) !== endIndex) return;
          for (const proposal of proposalsByRun.get(endRunId) ?? []) pushNode(proposalNode(proposal));
        };
        const decisionPending = (member: Entry) =>
          (member.kind === "gate" && member.approval.status === "pending")
          || (member.kind === "tools" && member.approvals.some((approval) => approval.status === "pending"));
        // A 1:1 thread names the bot on the head line of a run with work; a salon's room cards name their members.
        const headAuthor = (runId: string) => (defaultAuthor ? runAuthors?.get(runId) ?? defaultAuthor : null);
        // A run's status: live, the row at the bottom of its turn (`activity:<turn key>`, the
        // optimistic bubble's pending row, from the send to the end); done with work, the
        // summary on its head line above the reply (`head:…`). At the end, the bottom row
        // collapses then unmounts: a finished run keeps no room of its own.
        const runStatusNode = (runId: string, row: RunRow, place: "row" | "head", reveal = false) => {
          const live = runId === liveRunId;
          const members = place === "row" && !live ? [] : row.members;
          const pending = live && runId !== streamingRunId;
          const waiting = live && members.some(decisionPending);
          const forceOpen = members.some((member) =>
            decisionPending(member)
            || (activeFindTargetId != null && "targetId" in member && member.targetId === activeFindTargetId));
          const author = runAuthors?.get(runId) ?? defaultAuthor ?? null;
          const named = place === "head" && headAuthor(runId) !== null;
          const rowRun = runsById.get(runId);
          const runStart = rowRun ? runClockStart(rowRun) : Number.NaN;
          const since = Number.isFinite(runStart) ? runStart : pending ? activeSince : null;
          const workedMs = !live && rowRun?.createdAt && rowRun.endedAt
            ? Math.max(0, Date.parse(rowRun.endedAt) - runStart)
            : null;
          const reactKey = place === "head" ? submissionKeys.head(runId) : submissionKeys.host(runId);
          const log = members.length > 0 ? row.log : [];
          const sig = [
            reactKey,
            live,
            pending,
            row.writing,
            waiting,
            since ?? "",
            workedMs ?? "",
            forceOpen,
            named,
            reveal,
            authorRenderKey(author),
            log.map((member) => entryRenderSig(member)).join(""),
          ].join("\u0001");
          return cached(`${place}:${runId}`, sig, () => (
            <TurnActivity
              key={reactKey}
              runId={runId}
              calls={members.flatMap((member) => (member.kind === "tools" ? member.calls : []))}
              feed={turnFeed(log, t, streamSpeaker(author))}
              live={live}
              pending={pending}
              hasWork={members.length > 0}
              writing={row.writing}
              waiting={waiting}
              workedMs={workedMs !== null && Number.isFinite(workedMs) ? workedMs : null}
              since={since}
              forceOpen={forceOpen}
              author={author}
              showAuthorLabel={named}
              reveal={reveal}
            >
              {members.length > 0 ? members.map((member) => {
                // The folded log, in the runtime's order. Tool passages and web
                // searches render their own rows; every other step is one row.
                if (member.kind === "tools" || member.kind === "search") {
                  return <Fragment key={member.key}>{renderEntry(member, true)}</Fragment>;
                }
                const node = renderEntry(member, true);
                if (node === null) return null;
                return <ActivityRow key={member.key} kind={member.kind} className="px-1.5 py-1">{node}</ActivityRow>;
              }) : null}
            </TurnActivity>
          ));
        };
        // The head line opens a run with work, above its first bubble: the bot's name while
        // it works (1:1), then the summary in the same place once done. A run without work
        // has none, live or done. Appearing above a reply on screen, the line opens.
        const runHeadNode = (runId: string, row: RunRow): React.ReactNode => {
          const live = runId === liveRunId;
          if (row.members.length === 0) {
            if (live) lines.headless(runId);
            return null;
          }
          if (!live) return runStatusNode(runId, row, "head", lines.reveal(runId, linesNow, { summary: true }));
          const author = headAuthor(runId);
          if (!author) {
            lines.headless(runId);
            return null;
          }
          lines.named(runId);
          const reveal = lines.reveal(runId, linesNow, { summary: false });
          const key = submissionKeys.head(runId);
          return cached(`head:${runId}`, `${key}\u0001${reveal}\u0001${authorRenderKey(author)}`, () => <RunAuthorLine key={key} author={author} reveal={reveal} />);
        };
        const headsPushed = new Set<string>();
        const pushHead = (runId: string, row: RunRow) => {
          if (headsPushed.has(runId)) return;
          headsPushed.add(runId);
          const node = runHeadNode(runId, row);
          if (node) pushNode(node);
        };
        for (let index = 0; index < visible.length; index += 1) {
          // The previous entry (and the row that may follow it) is the last one handled.
          pushProposalsAfter(index - 1);
          const entry = visible[index]!;
          if (isTimelineTurnStart(entry, index)) {
            flushRoom();
            nodes = [];
            rows.push({ key: entry.key, nodes });
          }
          pushDay(entry);
          const runId = entryRunId(entry);
          const row = runId ? rowsByRun.get(runId) : undefined;
          // A tool passage's cards stay in the transcript at its place, between the bubbles.
          const toolCards = entry.kind === "tools" && callsHaveCards(entry.calls) ? entry.calls : null;
          if (workRunId(entry) === null || toolCards) {
            if (runId && row && entry.kind !== "user" && entry.kind !== "routine") pushHead(runId, row);
            pushNode(toolCards ? <ToolCallCards key={`cards:${entry.key}`} calls={toolCards} /> : renderCached(entry), entry);
          }
          if (!runId || !row || row.after !== index) continue;
          pushHead(runId, row);
          if (runId === liveRunId || closing.has(runId)) pushNode(runStatusNode(runId, row, "row"));
        }
        pushProposalsAfter(visible.length - 1);
        flushRoom();
        nodes = trailing;
        for (const [runId, proposals] of proposalsByRun) {
          if (!runsById.has(runId)) for (const proposal of proposals) pushNode(proposalNode(proposal));
        }
        flushRoom();
        // A live run with no entry in the window (a routine, or its turn not
        // mounted): its row joins the last turn, or the thinking status stands in.
        if (running && !outgoingThinks && !(liveRunId && rowsByRun.has(liveRunId))) {
          const pendingRow = spacerBottom > 0 ? undefined : rows.at(-1);
          if (liveRunId && pendingRow) {
            const empty: RunRow = { members: [], log: [], after: -1, writing: false };
            const head = runHeadNode(liveRunId, empty);
            if (head) pendingRow.nodes.push(head);
            pendingRow.nodes.push(runStatusNode(liveRunId, empty, "row"));
          } else {
            // A salon has no default author (a 1:1 thread does): the status then
            // names the member whose turn it is, since several bots can answer.
            const activeAuthor = defaultAuthor == null && activeRunId ? runAuthors?.get(activeRunId) ?? null : null;
            nodes.push(<PendingThinking key="pending-thinking" since={activeSince} author={activeAuthor} />);
          }
        }
        for (const key of nodeCache.keys()) {
          if (!liveCacheKeys.has(key)) nodeCache.delete(key);
        }
        // The unmounted turns are two spacers, at their measured or estimated height.
        // One flat keyed list, the optimistic bubble appended after it: the
        // saved row that replaces that bubble is the same element.
        return [
          spacerTop > 0 ? <div key="spacer:top" aria-hidden="true" data-thread-spacer="top" className="shrink-0" style={{ height: spacerTop }} /> : null,
          ...rows.map((row) => {
            const rowKey = submissionKeys.row(row.key);
            return (
              <div
                key={rowKey}
                ref={rowRef(row.key)}
                {...{ [THREAD_ROW_ATTRIBUTE]: row.key }}
                className={THREAD_TURN_CLASS}
              >
                {row.nodes}
              </div>
            );
          }),
          spacerBottom > 0 ? <div key="spacer:bottom" aria-hidden="true" data-thread-spacer="bottom" className="shrink-0" style={{ height: spacerBottom }} /> : null,
          ...trailing,
        ];
        }, [
          visible,
          spacerTop,
          spacerBottom,
          rowRef,
          proposalsByRun,
          isoBeforeWindow,
          assistantTurns,
          answeredQuestionByUserKey,
          attachedQuestionEntryKeys,
          interactionLabels,
          onReply,
          onReaction,
          messageVersionFamilies,
          onEditMessage,
          onRegenerateMessage,
          onSelectMessageVersion,
          onOpenBotApprovals,
          questionByRun,
          mentionSlugs,
          activeFindTargetId,
          authorLabelEntryKeys,
          defaultAuthor,
          runAuthors,
          streamingRunId,
          operatorUsername,
          mentionables,
          handoffNoticeByRun,
          speechDisabled,
          speechAdapter,
          speechState,
          playSpeech,
          speechVoiceByBotId,
          t,
          plural,
          formatNumber,
          runsById,
          withTurnAuthor,
          toolFailuresByRun,
          turnTimeByRun,
          running,
          outgoingThinks,
          hiddenAssistantRunIds,
          liveText,
          submissionKeys,
        ]),
        outgoing && outgoingKey ? (
          // Keyed as the saved row that will replace it (`sentTurnKey`): the
          // row, and the pending block keyed as the run's host, stay mounted.
          <div
            key={outgoingKey}
            data-thread-outgoing=""
            className={THREAD_TURN_CLASS}
          >
          <UserMessage
            text={outgoing.text}
            attachments={outgoing.attachments}
            mentionSlugs={mentionSlugs}
            findTargetId={`message:${outgoing.id}`}
          />
          {outgoingThinks && defaultAuthor ? (
            <TurnActivity key={`activity:${outgoingKey}`} calls={NO_CALLS} live pending forceOpen={false} author={defaultAuthor} showAuthorLabel={false}>
              {null}
            </TurnActivity>
          ) : null}
          {outgoing.failed && onRetryOutgoing ? (
            <button type="button" onClick={onRetryOutgoing} className={`${BUTTON.small} self-end`}>
              {t("common.retry")}
            </button>
          ) : null}
          </div>
        ) : null]}
        <div data-thread-scroll-anchor="" aria-hidden className={THREAD_SCROLL_ANCHOR_CLASS} />
      </div>
    </div>
    {atBottom ? null : (
      <StreamScrollDown
        label={t("threadTimeline.scrollToBottom")}
        onClick={() => {
          const node = scroller.current;
          if (!node) return;
          pinned.current = true;
          setAtBottom(true);
          // From far up, a smooth scroll would cross the spacers of unmounted turns: a jump instead.
          const far = node.scrollHeight - node.scrollTop - node.clientHeight > 2 * node.clientHeight;
          node.scrollTo({ top: node.scrollHeight, behavior: far ? "auto" : "smooth" });
          scrollBox.current = readThreadScrollBox(node);
        }}
      />
    )}
    </ThreadInitialLayout>
  );
}

export const ThreadTimeline = memo(ThreadTimelineView);
