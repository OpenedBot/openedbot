import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, CircleHelp, ListChecks } from "lucide-react";
import { AgentProgress, TrailItem, type AgentStep } from "@openedbot/browser-ui-kit";
import type { BotSettingProposalDto, MessageAuthorBot } from "@openedbot/contracts-api";
import { isTodoTool } from "@openedbot/execution/domain/agent-tool-call";
import { isServiceStepKind } from "@openedbot/execution/domain/run-step";
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
import { useThreadEditAvailability } from "../lib/thread/thread-edit-availability";
import { dismissComposerKeyboardFromThread } from "../lib/composer/composer-keyboard";
import {
  nextThreadPin,
  readThreadScrollBox,
  THREAD_ENTRY_GAP_PX,
  THREAD_MESSAGES_CLASS,
  THREAD_SCROLL_ANCHOR_CLASS,
} from "../lib/thread/thread-anchor";
import { THREAD_REVEAL_EVENT, type ThreadRevealDetail } from "../lib/thread/thread-turn-rail";
import {
  countTimelineTurns,
  growTimelineWindow,
  THREAD_FIRST_PAINT_TURN_WINDOW, THREAD_LIVE_TURN_WINDOW,
  THREAD_WINDOW_PAGE,
  windowTimelineEntries,
} from "../lib/thread/thread-window";
import { useT } from "../lib/i18n";
import { runTimings } from "../lib/run/run-timing";
import { speechRateFor } from "../lib/voice/speech-rates";
import { markdownToSpeechText } from "../lib/voice/speech-text";
import {
  createBrowserSpeechSynthesisAdapter,
  readSpeechOutputSettings,
  SPEECH_SETTINGS_EVENT,
  type SpeechOutputSettings,
} from "../lib/voice/web-speech-synthesis";
import {
  assistantTextParts,
  createTimelineModelBuilder,
  deriveTimelineWindow,
  entryAskSplit,
  eventText,
  type Entry,
  type TimelineModelBuilder,
} from "../lib/thread/thread-timeline-model";
import { authorRenderKey, entryRunId, entrySignature } from "../lib/thread/thread-timeline-signature";
import { AssistantAuthor, TurnAuthorHeader } from "./thread-author";
import { AssistantMessage, BotInboundMessage, ModelUnavailableNotice, ProviderAuthNotice, RoomAnswerCard, UserMessage } from "./thread-messages";
import { isModelUnavailableCode } from "../lib/run/model-unavailable";
import { isProviderAuthRequiredCode, providerAuthRequiredSlug } from "../lib/runtime/provider-auth";
import { ToolActivity } from "./thread-tool-activity";
import { PendingThinking } from "./thread-thinking-status";
import { ActivityNarration, ActivityRow, ActivitySearch, TurnActivity } from "./thread-turn-activity";
import { DateChip, Divider } from "./thread-timeline-chrome";
import { useThreadRowEnter } from "../lib/thread/thread-motion";
import type { ThreadTimelineProps } from "./thread-timeline-props";
import { AskUserCard } from "./ask-user-card";
import { dismissAskUser, useDismissedAskUserRuns } from "../lib/run/ask-user-dismissals";
import { openSecondaryReads, THREAD_FIRST_PAINT_MARK } from "../lib/shell/after-first-paint";
import { isConfirmedLiveAnswer } from "../lib/stream/live-answer";

/** Référence stable : un tableau `[]` recréé à chaque rendu casserait le
 * `memo` des bulles utilisateur (le `Set` de mentions en dépend). */
const EMPTY_MENTIONABLES: MentionableBot[] = [];
const EMPTY_SETTING_PROPOSALS: readonly BotSettingProposalDto[] = [];


/**
 * Distance (en entrées, pas en tours) au bas du fil sous laquelle une entrée
 * n'est JAMAIS contenue (`ohb-turn-contain`) : le run en direct grandit vite,
 * et un tour encore visible pourrait se voir donner une taille de repli
 * fausse par `contain-intrinsic-size`. La région NON contenue est aussi ce
 * que le `ResizeObserver` du fil (plus bas) doit remettre en page à chaque
 * mutation, contenue ou pas : mesuré, un `Enter` sur un fil de ~3500 nœuds
 * gardait 169 ms de mise en page forcée avec une marge de 12 entrées (aucune
 * lecture de géométrie individuelle > 8 ms : le coût vient du calcul natif
 * du `ResizeObserver`, pas d'un `scrollHeight` explicite). 6 entrées reste
 * largement au-delà des « ~3 derniers tours » demandés.
 */
const THREAD_SETTLED_ENTRY_MARGIN = 6;

/**
 * Le fil, mémoïsé.
 *
 * Chaque frappe du composer re-rend l'écran de conversation (le brouillon y
 * vit) ; sans ce `memo`, le fil rejouait à chaque touche sa construction
 * complète (cartes d'événements par run, entrelacement message/run, tri des
 * blocs, groupes d'outils) : latence visible dès qu'une conversation a un
 * peu d'histoire. Le `memo` ne tient que si l'écran passe des props STABLES :
 * voir les `useMemo` / `useCallback` de `conversation.tsx`. La bulle en vol
 * est une prop à part (`outgoing`) : elle ne doit pas recréer `userInputs`.
 */
/**
 * Un silence plus long relance une puce, à l'heure de la reprise, comme
 * Grok Bot (« Hier 16:41 ») : sans elle, une reprise trois heures plus tard
 * se lisait comme la suite immédiate du message précédent.
 */
export const THREAD_GAP_MS = 60 * 60 * 1000;

/** The instant that dates an entry's day chip: its own for a user message, its run's otherwise. */
function entryDayIso(entry: Entry, turnTimeByRun: ReadonlyMap<string, string>): string | undefined {
  const owner = entryRunId(entry);
  return entry.kind === "user" ? entry.createdAt : owner ? turnTimeByRun.get(owner) : undefined;
}

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
   * Le cloud API a borné sa lecture (`THREAD_SNAPSHOT_LIMITS`) : le début du fil
   * n'est pas là. Un plafond muet ferait lire ce fil comme un fil complet :
   * d'où une ligne, en tête, plutôt qu'un silence.
   */
  truncated = false,
  hasOlderHistory = false,
  loadingOlder = false,
  olderError = false,
  onLoadOlder,
  onOpenBotErrors,
}: ThreadTimelineProps) {
  // Les runs de SERVICE (brouillon de persona, compaction, et l'ancienne
  // extraction mémoire) partagent le fil du bot mais n'ont pas de bulle :
  // leur sortie est consommée par le worker. Sans ce filtre, leurs
  // `agent.message` formaient une bulle assistant vide sous l'avatar,
  // constatée à l'écran le 04-09.
  const events = useMemo(() => {
    const serviceRunIds = new Set(runs.filter((run) => isServiceStepKind(run.stepKind)).map((run) => run.id));
    return serviceRunIds.size === 0 ? allEvents : allEvents.filter((event) => !serviceRunIds.has(event.runId));
  }, [allEvents, runs]);
  const { t, locale, formatNumber, plural } = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Un message ajouté au bout du fil monte de 12 px, comme Grok Bot.
  useThreadRowEnter(content, scrollToBottomOnThreadKey);
  const speechAdapter = useMemo(
    () => injectedSpeechAdapter ?? createBrowserSpeechSynthesisAdapter(),
    [injectedSpeechAdapter],
  );
  const [speechSettings, setSpeechSettings] = useState<SpeechOutputSettings>(
    () => readSpeechOutputSettings(),
  );
  const [speechState, setSpeechState] = useState<{
    id: string | null;
    status: "idle" | "speaking" | "error";
  }>({ id: null, status: "idle" });
  const speechGeneration = useRef(0);
  // Épinglage (même règle que le viewport d'assistant-ui) : le fil ne suit le
  // flux que si le lecteur est DÉJÀ en bas. Avant, le scroll forcé sur chaque
  // événement recollait le fil en bas toutes les 500 ms pendant un stream,
  // même remonté pour relire (mesuré).
  const pinned = useRef(true);
  const lastUserInputId = userInputs[userInputs.length - 1]?.id ?? null;
  // Dernière boîte vue : `onScroll` compare pour distinguer un geste
  // (scrollTop ↓, hauteurs stables : assistant-ui #4141) d'une image qui
  // décode (scrollHeight ↑, le navigateur fire `scroll` et on lâchait).
  const scrollBox = useRef(readThreadScrollBox({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }));
  // Reflet réactif de `pinned` : le ref pilote le scroll (chaque frame,
  // aucune re-render), l'état pilote seulement le bouton « aller en bas »
  // (comme `ThreadPrimitive.ScrollToBottom` d'assistant-ui) : les deux ne
  // doivent jamais se confondre.
  const [atBottom, setAtBottom] = useState(true);
  const [liveTurns, setLiveTurns] = useState(THREAD_FIRST_PAINT_TURN_WINDOW);
  const restoreScrollHeight = useRef<number | null>(null);
  const pinFrame = useRef<number | null>(null);
  const schedulePin = useCallback(() => {
    if (pinFrame.current !== null) return;
    pinFrame.current = requestAnimationFrame(() => {
      pinFrame.current = null;
      const node = scroller.current;
      if (!node || !pinned.current) return;
      node.scrollTop = node.scrollHeight;
      scrollBox.current = readThreadScrollBox(node);
    });
  }, []);
  useEffect(() => () => {
    // Le ref survit au remontage (StrictMode en dev) : un id de frame annulée
    // laissé en place bloquait `schedulePin` pour toute la vie du fil.
    if (pinFrame.current !== null) cancelAnimationFrame(pinFrame.current);
    pinFrame.current = null;
  }, []);
  /**
   * Cache de nœuds React par tour : la clé est celle du tableau `nodes`
   * (`entry.key`, ou `activity:${entry.key}` pour un bloc d'activité). Un
   * SSE isolé change `windowed.visible` (nouvelle référence), donc rebâtit
   * `timelineModel` entier ; sans ce cache, l'useMemo de rendu reconstruisait
   * TOUS les nœuds (markdown, journaux d'outils) à chaque tick, y compris
   * ceux de tours réglés depuis longtemps, mesuré à 160-480 ms par tick sur
   * un fil de 1401 événements. La signature (`entrySignature` +
   * `entryRenderSig`) couvre les champs propres de l'entrée ET les quelques
   * lectures de contexte qui varient par tour (tronc, libellé d'auteur,
   * heure…) ; un tour dont rien de tout ça n'a changé reçoit EXACTEMENT le
   * même nœud qu'au tick précédent. React court-circuite alors sa
   * réconciliation dessus (comparaison par référence, avant même `memo`).
   */
  const turnNodeCache = useRef(new Map<string, { sig: string; node: React.ReactNode }>());
  // La disponibilité de l'édition passe par le store (`thread-edit-availability`),
  // hors des signatures de tour : sa bascule ne re-rend que les coques de message.
  const setCanEdit = useThreadEditAvailability((state) => state.setCanEdit);
  useLayoutEffect(() => {
    setCanEdit(canEditMessages);
    return () => setCanEdit(true);
  }, [canEditMessages, setCanEdit]);
  /** Dernière liste de dépendances « stables » vue par le cache ci-dessus. */
  const contextEpochRef = useRef<unknown[] | null>(null);
  // Set stable (même identité tant que `mentionables` ne change pas) : sinon
  // une nouvelle référence à chaque rendu casserait le `memo` de `UserMessage`
  // sur chaque delta du flux.
  const mentionSlugs = useMemo(
    () => new Set(mentionables.map((bot) => bot.slug)),
    [mentionables],
  );
  const interactionLabels = useMemo(() => ({
    reply: t("threadTimeline.reply"),
    helpful: t("boardui.helpful"),
    unhelpful: t("boardui.unhelpful"),
    copyResponse: t("boardui.copyResponse"),
    react: t("threadTimeline.react"),
    removeReaction: t("threadTimeline.removeReaction"),
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

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<SpeechOutputSettings>).detail;
      setSpeechSettings(detail ?? readSpeechOutputSettings());
    };
    window.addEventListener(SPEECH_SETTINGS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SPEECH_SETTINGS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    speechGeneration.current += 1;
    speechAdapter.cancel();
    setSpeechState({ id: null, status: "idle" });
    return () => {
      speechGeneration.current += 1;
      speechAdapter.cancel();
    };
  }, [speechAdapter, speechScope]);

  useEffect(() => {
    if (!speechDisabled) return;
    speechGeneration.current += 1;
    speechAdapter.cancel();
    setSpeechState({ id: null, status: "idle" });
  }, [speechAdapter, speechDisabled]);

  const playSpeech = useCallback((id: string, markdown: string, botVoiceId?: string | null, botId?: string | null) => {
    if (!speechAdapter.supported) return;
    if (speechState.id === id && speechState.status === "speaking") {
      speechGeneration.current += 1;
      speechAdapter.cancel();
      setSpeechState({ id: null, status: "idle" });
      return;
    }
    const text = markdownToSpeechText(markdown, locale);
    if (!text) return;
    const generation = ++speechGeneration.current;
    setSpeechState({ id, status: "speaking" });
    speechAdapter.speak({
      text,
      lang: locale,
      voiceURI: botVoiceId ?? speechSettings.voiceURI,
      rate: speechRateFor(botId),
      onStart: () => {
        if (speechGeneration.current === generation) setSpeechState({ id, status: "speaking" });
      },
      onEnd: () => {
        if (speechGeneration.current === generation) setSpeechState({ id: null, status: "idle" });
      },
      onError: () => {
        if (speechGeneration.current === generation) setSpeechState({ id, status: "error" });
      },
    });
  }, [locale, speechAdapter, speechSettings.voiceURI, speechState]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    pinned.current = true;
    setAtBottom(true);
    node.scrollTop = node.scrollHeight;
    scrollBox.current = readThreadScrollBox(node);
  }, [scrollToBottomOnThreadKey]);

  useEffect(() => {
    pinned.current = true;
    setAtBottom(true);
    schedulePin();
  }, [approvals.length, lastUserInputId, outgoing?.id, resnap, schedulePin]);

  useEffect(() => {
    // Le contenu grandit aussi ENTRE deux événements (lissage caractère par
    // caractère) : seul un ResizeObserver voit ces pas-là. Il suit le bas
    // uniquement si le lecteur y est épinglé.
    const contentNode = content.current;
    if (!contentNode || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      if (!entries.some((entry) => entry.target === contentNode)) return;
      const node = scroller.current;
      if (!node) return;
      schedulePin();
    });
    observer.observe(contentNode);
    return () => observer.disconnect();
  }, [schedulePin]);

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

  useEffect(() => {
    setLiveTurns(THREAD_FIRST_PAINT_TURN_WINDOW);
    restoreScrollHeight.current = null;
  }, [speechScope, scrollToBottomOnThreadKey]);
  const windowed = useMemo(
    () => windowTimelineEntries(timelineModelBase.shown, liveTurns),
    [timelineModelBase.shown, liveTurns],
  );
  const timelineModel = useMemo(
    () => deriveTimelineWindow(timelineModelBase, timelineInput, windowed.visible),
    [timelineModelBase, timelineInput, windowed.visible],
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
    for (const entry of windowed.visible) {
      const runId = entryRunId(entry);
      if (runId) ids.add(runId);
    }
    return ids;
  }, [windowed.visible]);
  // Les propositions du bot se posent à la fin du tour de leur run. Une
  // proposition dont le run est inconnu du fil n'a pas de tour où se poser :
  // elle ferme le fil plutôt que de disparaître.
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
  const hasEntries = windowed.visible.length > 0;
  useEffect(() => {
    if (!hasEntries) return;
    const frame = requestAnimationFrame(() => {
      // Read by perf passes: when a refresh actually shows its messages.
      if (!performance.getEntriesByName(THREAD_FIRST_PAINT_MARK).length) performance.mark(THREAD_FIRST_PAINT_MARK);
      openSecondaryReads();
    });
    return () => cancelAnimationFrame(frame);
  }, [hasEntries]);
  // Then the rest of the live window, once the browser is idle. A reader who
  // scrolled up keeps their viewport; a pinned reader follows the new bottom.
  const growToLiveWindow = liveTurns < THREAD_LIVE_TURN_WINDOW && windowed.hasOlder;
  // Until that growth, the top of the first window must stay out of view. It
  // is often barely taller than the viewport, so whatever opened it (the day
  // separator of its oldest turn, the "load earlier" button) was painted at
  // the top of the screen, then pushed thousands of pixels up by the growth:
  // on every refresh it appeared, then vanished. A spacer stands in for the
  // turns the growth will add, at their estimated height (the
  // `contain-intrinsic-size` of `.ohb-turn-contain`) and never less than a
  // screen: the reader pinned to the bottom never sees the swap.
  const pendingGrowthTurns = growToLiveWindow
    ? Math.min(windowed.turnCount, THREAD_LIVE_TURN_WINDOW) - liveTurns
    : 0;
  const showOlder = !growToLiveWindow && (windowed.hasOlder || hasOlderHistory);
  // A day chip opens a day of the THREAD, not of the window: the oldest turn
  // mounted only gets one when the turn hidden before it is from another day.
  // Otherwise the first window opened on a chip ("5 oct. 2026") that the
  // growth then replaced by older turns of that same day.
  // The same holds for a gap chip: the hidden turn's instant is the one the
  // first mounted turn is measured against.
  const isoBeforeWindow = useMemo(() => {
    for (let index = shown.length - windowed.visible.length - 1; index >= 0; index -= 1) {
      const iso = entryDayIso(shown[index]!, turnTimeByRun);
      if (iso) return iso;
    }
    return null;
  }, [shown, windowed.visible.length, turnTimeByRun]);
  useEffect(() => {
    if (!growToLiveWindow) return;
    const grow = () => {
      const node = scroller.current;
      if (node) restoreScrollHeight.current = node.scrollHeight;
      setLiveTurns((current) => Math.max(current, THREAD_LIVE_TURN_WINDOW));
    };
    if (typeof window.requestIdleCallback === "function") {
      const idle = window.requestIdleCallback(grow, { timeout: 600 });
      return () => window.cancelIdleCallback(idle);
    }
    const timer = window.setTimeout(grow, 50);
    return () => window.clearTimeout(timer);
  }, [growToLiveWindow]);
  useLayoutEffect(() => {
    const previous = restoreScrollHeight.current;
    if (previous == null) return;
    restoreScrollHeight.current = null;
    const node = scroller.current;
    if (!node) return;
    if (pinned.current) {
      // Before the paint: a frame drawn between this commit and the next
      // animation frame would show the top of the grown window.
      node.scrollTop = node.scrollHeight;
      schedulePin();
      return;
    }
    node.scrollTop += node.scrollHeight - previous;
    scrollBox.current = readThreadScrollBox(node);
  }, [liveTurns, shown, schedulePin]);
  // A first window that does not fill the screen grows before its paint: on a
  // tall screen, or a thread of short turns, eight turns left the spacer in
  // view and the growth then filled the top of the screen under the reader.
  // One layout read per commit until the idle growth ends it. Declared after
  // the pin above: a growth commit is pinned before the next one is asked.
  const growthSpacer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!growToLiveWindow) return;
    const node = scroller.current;
    const body = content.current;
    if (!node || !body) return;
    const ownHeight = body.scrollHeight - (growthSpacer.current?.offsetHeight ?? 0);
    if (ownHeight >= node.clientHeight) return;
    // Just enough turns to fill the screen, doubling each commit: rendering
    // the whole live window here put every one of its turns on the critical
    // path of the refresh.
    restoreScrollHeight.current = node.scrollHeight;
    setLiveTurns((current) => Math.min(THREAD_LIVE_TURN_WINDOW, current * 2));
  });

  // Le rail des tours (`thread-turn-rail.tsx`) demande un tour sorti de la
  // fenêtre montée : la fenêtre grandit jusqu'à lui, puis le fil s'y pose.
  // `shown` est lu par ref : l'écouteur ne se réabonne pas à chaque SSE.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const pendingReveal = useRef<string | null>(null);
  useEffect(() => {
    const onReveal = (event: Event) => {
      const targetId = (event as CustomEvent<ThreadRevealDetail>).detail?.targetId;
      const entries = shownRef.current;
      const index = entries.findIndex((entry) => "targetId" in entry && entry.targetId === targetId);
      if (!targetId || index < 0) return;
      pinned.current = false;
      setAtBottom(false);
      // Déjà monté : posé tout de suite, sans animation (une animation
      // repasse par la zone « en bas » et pourrait y recoller le fil).
      const mounted = scroller.current?.querySelector<HTMLElement>(
        `[data-thread-find-target="${CSS.escape(targetId)}"]`,
      );
      if (mounted) {
        mounted.scrollIntoView({ block: "start" });
        return;
      }
      pendingReveal.current = targetId;
      const needed = countTimelineTurns(entries.slice(index));
      setLiveTurns((current) => Math.max(current, needed));
    };
    document.addEventListener(THREAD_REVEAL_EVENT, onReveal);
    return () => document.removeEventListener(THREAD_REVEAL_EVENT, onReveal);
  }, []);
  useLayoutEffect(() => {
    const targetId = pendingReveal.current;
    if (!targetId) return;
    pendingReveal.current = null;
    scroller.current
      ?.querySelector<HTMLElement>(`[data-thread-find-target="${CSS.escape(targetId)}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [windowed.visible]);

  const withTurnAuthor = useCallback((entryKey: string, runId: string, content: React.ReactNode): React.ReactNode => {
    const trail = trailPositions.get(entryKey);
    // Le tronc part du glyphe du bloc, jamais du visage du bot : il se pose
    // DANS la réponse de l'en-tête, pas autour.
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

  // Les échecs d'outils de chaque tour : un plan clos ne doit pas se lire
  // « sans accroc » quand un outil du même run a échoué.
  const toolFailuresByRun = useMemo(() => {
    const failures = new Map<string, number>();
    for (const entry of windowed.visible) {
      if (entry.kind !== "tools") continue;
      const count = entry.calls.filter((call) => !isTodoTool(call.tool) && call.failed).length;
      if (count > 0) failures.set(entry.runId, (failures.get(entry.runId) ?? 0) + count);
    }
    return failures;
  }, [windowed.visible]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div
      ref={scroller}
      // Une région défilante doit rester atteignable au clavier : sans
      // `tabIndex`, la transcription ne peut pas être parcourue sans souris
      // (axe : `scrollable-region-focusable`).
      tabIndex={0}
      role="log"
      aria-label={t("threadTimeline.transcriptLabel")}
      className="ohb-thread-scroll-contain bui-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-2 pb-4 outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-inset"
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
      }}
    >
      <div ref={content} data-thread-messages="" className={THREAD_MESSAGES_CLASS}>
        {pendingGrowthTurns > 0 ? (
          <div ref={growthSpacer} aria-hidden="true" data-thread-growth-spacer="" style={{ height: `max(100vh, ${pendingGrowthTurns * 120}px)` }} />
        ) : null}
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
            onClick={async () => {
              pinned.current = false;
              setAtBottom(false);
              const captureHeight = () => {
                const node = scroller.current;
                if (node) restoreScrollHeight.current = node.scrollHeight;
              };
              if (windowed.hasOlder) {
                captureHeight();
                setLiveTurns((current) => growTimelineWindow(current, THREAD_WINDOW_PAGE, windowed.turnCount));
              } else if (await onLoadOlder?.(captureHeight)) {
                setLiveTurns((current) => current + THREAD_WINDOW_PAGE);
              }
            }}
          >
            {loadingOlder ? t("threadTimeline.loadingEarlier") : t("threadTimeline.loadEarlier", {
              count: windowed.hasOlder ? Math.min(THREAD_WINDOW_PAGE, windowed.hiddenTurns) : THREAD_WINDOW_PAGE,
            })}
          </button>
        ) : null}
        {olderError ? <p role="alert" className="py-2 text-center text-xs text-destructive-text">{t("threadTimeline.earlierLoadFailed")}</p> : null}
        {useMemo(() => {
        const renderEntry = (
          entry: Entry,
          inActivity = false,
          settled = false,
        ): React.ReactNode => {
          // Dans le bloc d'activité, l'en-tête d'auteur et le tronc de trace
          // appartiennent au bloc, pas à chacune de ses entrées.
          const wrapTurn = (key: string, runId: string, node: React.ReactNode) =>
            inActivity ? node : withTurnAuthor(key, runId, node);
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
                    settled={settled}
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
                    settled={settled}
                  />
                )}
              </MessageInteractionShell>
            );
          if (entry.kind === "assistant") {
            // La carte de plan porte cette prose. La laisser en bulle
            // doublerait la réponse sous le dock.
            if (hiddenAssistantRunIds.length > 0 && hiddenAssistantRunIds.split(",").includes(entry.runId)) {
              return null;
            }
            if (inActivity) {
              return (
                <ActivityNarration
                  key={entry.key}
                  text={entry.text}
                  streaming={entry.runId === streamingRunId}
                />
              );
            }
            // La bulle garde la prose ; la question terminale appartient au
            // panneau (le run actif) ou se replie en une ligne (l'historique).
            // Jamais le bloc brut `@handle` + puces : c'est de la tuyauterie.
            // Le filtrage des lignes `remember:` a disparu avec le régime
            // mémoire d'openedbot (07-09) : plus rien ne les produit ni ne les
            // consomme, ce que le bot retient vit dans son magasin Hermes.
            const visible = entry.text;
            const split = entryAskSplit(entry, operatorUsername);
            const live = entry.runId === activeAskUserRunId;
            const questionAttachedToAnswer = attachedQuestionEntryKeys.has(entry.key);
            const shown = split.prompt ? split.body : visible;
            // Même règle pour la directive de hand-off `@slug …` : dès qu'une
            // notice l'explique, la ligne brute sort de la bulle. Transmise,
            // elle se replie en « → transmis à 🤖 X » ; REFUSÉE, elle disparaît
            // : rien n'est parti, et la notice de refus dit déjà pourquoi dans
            // le fil. Le split s'applique au texte FUSIONNÉ : pendant le
            // streaming la ligne peut apparaître un instant, mais la notice
            // arrive avec la fin du tour : elle ne reste jamais brute une fois
            // le run conclu.
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
            // Copier, lire et réagir attendent la fin du run : tant qu'il
            // tourne, d'autres outils peuvent encore se poser sous ce
            // fragment, et la barre se retrouvait au milieu du tour.
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
                      text={publicText}
                      attachments={entry.attachments}
                      author={entry.author ?? defaultAuthor}
                      streaming={entry.runId === streamingRunId}
                      timing={turnEnd ? timingsByRun.get(entry.runId) ?? null : null}
                      liveSince={turnLive && (!turn || turn.lastKey === entry.key) ? turnRun.createdAt ?? null : null}
                      findTargetId={entry.messageId ? `message:${entry.messageId}` : entry.targetId}
                      findActive={(entry.messageId ? `message:${entry.messageId}` : entry.targetId) === activeFindTargetId}
                      hover={turnEnd ? cardHover : undefined}
                      settled={settled}
                    />
                  </MessageInteractionShell>
                ) : null}
                {relayed ? (
                  // L'instruction transmise se replie par défaut : la ligne dit
                  // À QUI, le dépliage dit QUOI : le message vit déjà chez la
                  // cible, la bulle d'origine n'a pas à le crier deux fois.
                  // Un refus n'a pas cette ligne : rien n'a été transmis, et
                  // annoncer une cible mentirait sur ce qui s'est passé.
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
            case "run.error": {
              // Le code vient de l'événement (direct), sinon du run (relu).
              const failedRun = runsById.get(event.runId);
              const code = typeof event.payload.errorCode === "string" ? event.payload.errorCode : failedRun?.errorCode;
              const authProvider = isProviderAuthRequiredCode(code) ? providerAuthRequiredSlug(event.payload) : null;
              if (authProvider) {
                const author = runAuthors?.get(event.runId) ?? defaultAuthor;
                return (
                  <ProviderAuthNotice
                    key={entry.key}
                    name={author?.name ?? author?.slug ?? t("threadTimeline.unknownBot")}
                    provider={authProvider}
                    findTargetId={entry.targetId}
                    findActive={entry.targetId === activeFindTargetId}
                  />
                );
              }
              if (isModelUnavailableCode(code)) {
                const author = runAuthors?.get(event.runId) ?? defaultAuthor;
                return (
                  <ModelUnavailableNotice
                    key={entry.key}
                    name={author?.name ?? author?.slug ?? t("threadTimeline.unknownBot")}
                    model={failedRun?.model ?? (typeof event.payload.model === "string" ? event.payload.model : null)}
                    botId={author?.id ?? null}
                    findTargetId={entry.targetId}
                    findActive={entry.targetId === activeFindTargetId}
                  />
                );
              }
              return (
                <p
                  key={entry.key}
                  data-thread-find-target={entry.targetId}
                  className={`max-w-[85%] self-start rounded-2xl rounded-bl-md bg-destructive px-3.5 py-2.5 text-sm font-medium text-white ${entry.targetId === activeFindTargetId ? "ring-2 ring-primary ring-offset-2" : ""}`}
                >
                  {eventText(event) || t("threadTimeline.runtimeErrorFallback")}
                </p>
              );
            }
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
              // Aligné sur Hermes-Bot-Mode : le silence reste silencieux. La
              // notice `group.pass` ne sert qu'à masquer le texte streamé
              // (`passedRuns` ci-dessus). « Le salon se calme. » n'est plus émise ;
              // les fils d'avant gardent la leur en base, elle ne se rend plus.
              if (event.payload.kind === "group.pass" || event.payload.kind === SUPERSEDED_NOTICE_KIND) return null;
              if (event.payload.kind === "group.settled" && eventText(event) === "Le salon se calme.") return null;
              // Les avis de l'ancienne mémoire openedbot (`memory.fact`, `memory.full`)
              // restent dans les fils d'avant le 07-09 : ils ne se rendent plus.
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
              // La gate elle-même (`GateCard`) porte déjà la décision prise :
              // un divider redondant après chaque validation encombrait le fil.
              return null;
            case "bot.message":
              // Signal de relecture seulement : la ligne s'affiche via `messages` (BotInboundMessage ci-dessus).
              return null;
            default:
              // `tool.result`, `tool.result.attached`, `approval.requested`,
              // `raw`, `run.completed` : soit déjà rendus ailleurs (la ligne
              // `ToolActivity` de l'appel correspondant, pour les deux
              // premiers), soit sans valeur d'affichage propre.
              return null;
          }
        };
        // Le bloc d'activité d'un tour : les entrées CONSÉCUTIVES d'un même run
        // qui relèvent du travail (plan, recherches, outils, décisions) et les
        // phrases de narration écrites avant le dernier outil. La réponse est
        // le texte qui suit ce dernier outil : elle reste hors du bloc.
        const visible = windowed.visible;
        const workRunId = (entry: Entry): string | null => {
          if (entry.kind === "plan" || entry.kind === "search") return entry.runId;
          if (entry.kind === "tools") {
            return entry.calls.some((call) => !isTodoTool(call.tool)) || entry.approvals.length > 0
              ? entry.runId
              : null;
          }
          if (entry.kind === "gate") return entry.approval.runId ?? null;
          return null;
        };
        const lastEntryIndex = new Map<string, number>();
        visible.forEach((entry, index) => {
          const runId = entryRunId(entry);
          if (runId) lastEntryIndex.set(runId, index);
        });
        const lastWorkIndex = new Map<string, number>();
        visible.forEach((entry, index) => {
          const runId = workRunId(entry);
          if (runId) lastWorkIndex.set(runId, index);
        });
        const activityRunId = (entry: Entry, index: number): string | null => {
          const work = workRunId(entry);
          if (work) return work;
          if (entry.kind !== "assistant") return null;
          // Une question ask_user ou une directive de transmission a son propre
          // rendu : elle ne se range pas dans l'activité.
          if (entryAskSplit(entry, operatorUsername).prompt) return null;
          if (handoffNoticeByRun.has(entry.runId)) return null;
          const last = lastWorkIndex.get(entry.runId);
          if (last !== undefined && index < last) return entry.runId;
          // Run en cours : un texte pas encore confirmé comme réponse
          // (`isConfirmedLiveAnswer`) est une narration probable, AVANT le
          // premier outil comme après le dernier. Il s'écrit dans le bloc au
          // lieu de commencer la réponse puis d'y sauter quand l'outil arrive.
          // Le run conclu en fait la réponse.
          return entry.runId === streamingRunId && !isConfirmedLiveAnswer(entry.text)
            ? entry.runId
            : null;
        };
        // Rien au-delà des `THREAD_SETTLED_ENTRY_MARGIN` dernières entrées, et
        // rien du run en direct : ces tours reçoivent `content-visibility:
        // auto` (voir `ohb-turn-contain`, thread-timeline.css). La marge
        // couvre large plutôt que de risquer de contenir un tour encore
        // proche du bas, là où une taille de repli approximative se verrait.
        // Nor anything of the first window: its height decides, before its
        // paint, whether it fills the screen, and a contained turn only
        // measures its fallback size there (120 px for a 45 px turn).
        const isSettledIndex = (endIndex: number, runId: string | null): boolean =>
          !growToLiveWindow && runId !== streamingRunId && visible.length - 1 - endIndex >= THREAD_SETTLED_ENTRY_MARGIN;
        // Le compte de tokens transmis (bloc « relayed ») relit `events`/`runs`
        // en entier : les inclure dans la signature de cache viderait le
        // cache à CHAQUE tick SSE. Ce cas reste rare (une directive de
        // hand-off transmise), on le sort simplement du cache plutôt que de
        // payer ce coût pour tous les tours.
        const skipsCache = (entry: Entry): boolean =>
          entry.kind === "assistant" && handoffNoticeByRun.get(entry.runId)?.outcome === "relayed";
        // Signature de rendu d'une entrée : ses champs propres
        // (`entrySignature`) + les lectures de contexte qui varient par tour
        // (tronc, libellé d'auteur, heure, question répondue, tour agrégé
        // d'un run en plusieurs fragments…). Tout le reste (libellés i18n,
        // callbacks, cible de recherche active…) est stable d'un tick SSE à
        // l'autre ; un changement y vide le cache entier via `contextEpoch`
        // ci-dessous plutôt que d'être recalculé ici pour chaque tour.
        const entryRenderSig = (entry: Entry): string => {
          const runId = entryRunId(entry);
          // `running`/`streamingRunId` changent à CHAQUE
          // démarrage ou fin de run : les mettre dans `contextEpochDeps`
          // (contexte global) viderait le cache entier à ce moment-là, mesuré
          // à 458-507 ms. Ils n'affectent en réalité que le tour concerné (un
          // run passé garde un statut terminal quel que soit `running`) : leur
          // EFFET est donc lu ici, par tour. L'édition permise ou non passe
          // par le store `thread-edit-availability`, hors signature.
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
            turnText: entry.kind === "assistant" ? assistantTurns.get(entry.runId)?.text ?? "" : null,
            toolFailures: entry.kind === "plan" ? toolFailuresByRun.get(entry.runId) ?? 0 : null,
            runStatus: entry.kind === "plan" || entry.kind === "search"
              ? runsById.get(entry.runId)?.status ?? null
              : null,
            // `runAuthors`, `messageVersionFamilies` et `speechVoiceByBotId`
            // sont des Maps recréées à chaque run ajouté ou roster patché :
            // en contexte global elles vidaient tout le cache au 202 (mesuré
            // à 343 ms). Seule la valeur lue par CE tour compte.
            author: runId ? authorRenderKey(runAuthors?.get(runId) ?? defaultAuthor) : null,
            voice: runId ? speechVoiceByBotId?.get((runAuthors?.get(runId) ?? defaultAuthor)?.id ?? "") ?? null : null,
            version: entry.kind === "user" ? messageVersionFamilies?.get(entry.key) ?? null : null,
            planHidden: entry.kind === "assistant" && hiddenAssistantRunIds.length > 0
              && hiddenAssistantRunIds.split(",").includes(entry.runId),
          };
          return `${entrySignature(entry)}${JSON.stringify(ctx)}`;
        };
        // Contexte STABLE d'un tick SSE à l'autre (props, callbacks, réglages),
        // jamais les Maps reconstruites à chaque passage de `timelineModel`, ni
        // les drapeaux qui varient par run (lus par tour ci-dessus). Une
        // différence de référence ici est rare (langue, cible de recherche,
        // bascule voix) et vide tout le cache. Les écrans passent donc des
        // callbacks d'identité stable (lectures par ref, pas de dépendance
        // aux données du fil) : sinon chaque 202 re-rend tout le fil.
        // Les mentions par leur CONTENU : `mentionables` est recalculé à chaque
        // patch du roster (202, flux) sans que les bots mentionnables changent.
        const mentionKey = mentionables
          .map((candidate) => `${candidate.id}:${candidate.slug}:${authorRenderKey(candidate)}`)
          .join("|");
        // L'auteur par défaut est reconstruit à chaque patch du roster. La clé
        // de contenu (id, nom, slug, visage) garde le cache des tours tant que
        // cet auteur n'a pas vraiment changé (DEV-218).
        const defaultAuthorKey = authorRenderKey(defaultAuthor);
        const contextEpochDeps = [
          interactionLabels, onReply, onReaction, onEditMessage, onRegenerateMessage, onAskUserPick,
          onSelectMessageVersion, mentionKey, activeFindTargetId,
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
        const renderCached = (entry: Entry, settled: boolean): React.ReactNode =>
          skipsCache(entry)
            ? renderEntry(entry, false, settled)
            : cached(entry.key, entryRenderSig(entry), () => renderEntry(entry, false, settled));

        const nodes: React.ReactNode[] = [];
        // La carte dépend de la proposition seule (pas des callbacks ni des
        // libellés du contexte) : elle vit dans le cache par tour avec sa propre
        // signature, jamais dans `contextEpochDeps`.
        const proposalNode = (proposal: BotSettingProposalDto): React.ReactNode =>
          cached(
            `proposal:${proposal.id}`,
            JSON.stringify([proposal.status, proposal.hash, proposal.reason, proposal.resolvedAt]),
            () => <SettingProposalCard key={`proposal:${proposal.id}`} proposal={proposal} botId={proposal.botId} />,
          );
        // Salon : les réponses consécutives de plusieurs membres forment UNE
        // carte d'équipe. Les nœuds enveloppés restent ceux du cache par tour.
        // En mode équipe, la synthèse passe en tête. Les contributions
        // s'ouvrent dessous, chacune signée par son bot.
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
        // Template BoardUI : une puce de date ouvre chaque jour du fil, et
        // une reprise après un long silence (`THREAD_GAP_MS`).
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
        // Les cartes de proposition suivent la DERNIÈRE entrée visible de leur run.
        const pushProposalsAfter = (endIndex: number) => {
          const endRunId = endIndex >= 0 ? entryRunId(visible[endIndex]!) : null;
          if (!endRunId || lastEntryIndex.get(endRunId) !== endIndex) return;
          for (const proposal of proposalsByRun.get(endRunId) ?? []) pushNode(proposalNode(proposal));
        };
        let liveGroupRendered = false;
        const answeredRunIds = new Set<string>();
        for (const candidate of visible) {
          if (candidate.kind === "assistant" && candidate.text.trim() !== "") answeredRunIds.add(candidate.runId);
        }
        for (let index = 0; index < visible.length; index += 1) {
          // `index` a déjà avancé : l'entrée précédente (ou la fin de son
          // groupe d'activité) est la dernière traitée.
          pushProposalsAfter(index - 1);
          const entry = visible[index]!;
          pushDay(entry);
          const runId = activityRunId(entry, index);
          if (!runId) {
            pushNode(renderCached(entry, isSettledIndex(index, entryRunId(entry))), entry);
            continue;
          }
          const groupStartIndex = index;
          const members: Entry[] = [entry];
          while (index + 1 < visible.length && activityRunId(visible[index + 1]!, index + 1) === runId) {
            index += 1;
            members.push(visible[index]!);
          }
          // Des phrases seules, sans travail entre elles, ne font pas une activité,
          // sauf en direct : la phrase en cours y attend de savoir si un outil
          // la suit. Every turn with work, even a single tool call, gets the
          // same Agent Activity block: one way to read a turn's work.
          if (runId !== streamingRunId && !members.some((member) => workRunId(member) !== null)) {
            members.forEach((member, offset) => {
              pushNode(renderCached(member, isSettledIndex(groupStartIndex + offset, entryRunId(member))), member);
            });
            continue;
          }
          const live = runId === streamingRunId;
          if (live) liveGroupRendered = true;
          // The answer has started below the block (text already confirmed as
          // the answer, outside the group): the live status folds to its
          // summary line, "Thought for ...".
          const answering = live && visible.some((candidate, candidateIndex) =>
            candidate.kind === "assistant" && candidate.runId === runId && candidate.text.trim() !== ""
            && activityRunId(candidate, candidateIndex) === null);
          const waiting = live && members.some((member) =>
            (member.kind === "gate" && member.approval.status === "pending")
            || (member.kind === "tools" && member.approvals.some((approval) => approval.status === "pending")));
          const forceOpen = members.some((member) =>
            (member.kind === "gate" && member.approval.status === "pending")
            || (member.kind === "tools" && member.approvals.some((approval) => approval.status === "pending"))
            || (activeFindTargetId != null && "targetId" in member && member.targetId === activeFindTargetId)
            || (member.kind === "assistant" && member.messageId != null && `message:${member.messageId}` === activeFindTargetId),
          );
          const showAuthorLabel = members.some((member) => authorLabelEntryKeys.has(member.key));
          const groupSettled = isSettledIndex(index, runId);
          const groupRun = runsById.get(runId);
          const workedMs = !live && groupRun?.createdAt && groupRun.endedAt
            ? Math.max(0, Date.parse(groupRun.endedAt) - Date.parse(groupRun.createdAt))
            : null;
          const runStart = groupRun?.createdAt ? Date.parse(groupRun.createdAt) : Number.NaN;
          const activitySig = [
            live,
            answering,
            waiting,
            runStart,
            workedMs ?? "",
            forceOpen,
            showAuthorLabel,
            authorRenderKey(runAuthors?.get(runId) ?? defaultAuthor),
            groupSettled,
            members.map((member) => entryRenderSig(member)).join(""),
          ].join("");
          pushNode(
            cached(`activity:${entry.key}`, activitySig, () => (
              <TurnActivity
                key={`activity:${entry.key}`}
                calls={members.flatMap((member) => (member.kind === "tools" ? member.calls : []))}
                live={live}
                workedMs={workedMs !== null && Number.isFinite(workedMs) ? workedMs : null}
                since={Number.isFinite(runStart) ? runStart : null}
                answering={answering}
                waiting={waiting}
                forceOpen={forceOpen}
                author={runAuthors?.get(runId) ?? defaultAuthor ?? null}
                showAuthorLabel={showAuthorLabel}
                settled={groupSettled}
              >
                {members.map((member) => {
                  // The feed, in the runtime's order. Tool passages and web
                  // searches render their own rows (one per group, one per
                  // query); every other step is one row.
                  if (member.kind === "tools" || member.kind === "search") {
                    return <Fragment key={member.key}>{renderEntry(member, true)}</Fragment>;
                  }
                  const node = renderEntry(member, true);
                  if (node === null) return null;
                  return (
                    <ActivityRow
                      key={member.key}
                      kind={member.kind === "assistant" ? "thinking" : member.kind}
                      className={member.kind === "assistant" ? undefined : "px-1.5 py-1"}
                    >
                      {node}
                    </ActivityRow>
                  );
                })}
              </TurnActivity>
            )),
          );
        }
        pushProposalsAfter(visible.length - 1);
        for (const [runId, proposals] of proposalsByRun) {
          if (!runsById.has(runId)) for (const proposal of proposals) pushNode(proposalNode(proposal));
        }
        flushRoom();
        // A run is working and no block of its own exists yet (queued, or
        // thinking before the first step): the thinking status stands in. Once
        // an answer has text, the status gives way to it.
        if (running && !liveGroupRendered && !answeredRunIds.has(streamingRunId ?? "")) {
          let since: number | null = null;
          let activeRunId: string | null = null;
          for (const candidate of runsById.values()) {
            if (candidate.status === "completed" || candidate.status === "failed" || candidate.status === "cancelled") continue;
            const created = candidate.createdAt ? Date.parse(candidate.createdAt) : Number.NaN;
            if (Number.isFinite(created) && (since === null || created > since)) {
              since = created;
              activeRunId = candidate.id;
            }
          }
          // A salon has no default author (a 1:1 thread does): the status then
          // names the member whose turn it is, since several bots can answer.
          const activeAuthor = defaultAuthor == null && activeRunId ? runAuthors?.get(activeRunId) ?? null : null;
          nodes.push(<PendingThinking key="pending-thinking" since={since} author={activeAuthor} />);
        }
        for (const key of nodeCache.keys()) {
          if (!liveCacheKeys.has(key)) nodeCache.delete(key);
        }
        return nodes;
        }, [
          windowed.visible,
          proposalsByRun,
          isoBeforeWindow,
          growToLiveWindow,
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
          hiddenAssistantRunIds,
        ])}
        {outgoing ? (
          // Une vraie boîte (pas un Fragment) : `useThreadRowEnter` la fait
          // monter, puis reconnaît la rangée enregistrée qui la remplace.
          <div data-thread-outgoing="" className="flex flex-col gap-3">
          <UserMessage
            text={outgoing.text}
            attachments={outgoing.attachments}
            mentionSlugs={mentionSlugs}
            findTargetId={`message:${outgoing.id}`}
          />
          {outgoing.failed && onRetryOutgoing ? (
            <button type="button" onClick={onRetryOutgoing} className={`${BUTTON.small} self-end`}>
              {t("common.retry")}
            </button>
          ) : null}
          </div>
        ) : null}
        <div data-thread-scroll-anchor="" aria-hidden className={THREAD_SCROLL_ANCHOR_CLASS} />
      </div>
    </div>
    {atBottom ? null : (
      <button
        type="button"
        aria-label={t("threadTimeline.scrollToBottom")}
        onClick={() => {
          const node = scroller.current;
          if (!node) return;
          pinned.current = true;
          setAtBottom(true);
          node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
          scrollBox.current = readThreadScrollBox(node);
        }}
        data-thread-scroll-bottom=""
        className="ohb-scroll-bottom-enter absolute bottom-3 z-10 flex size-8 items-center justify-center rounded-full border border-border-button-default bg-background-primary-default text-foreground-icon-primary shadow-xs outline-none transition-colors hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <ChevronDown aria-hidden className="size-4" />
      </button>
    )}
    </div>
  );
}

export const ThreadTimeline = memo(ThreadTimelineView);

/** « Ignorée » après une question repliée par le « x » de sa carte. */
function AskUserDismissedMark({ runId }: { runId: string }) {
  const { t } = useT();
  const dismissed = useDismissedAskUserRuns();
  if (!dismissed.includes(runId)) return null;
  return (
    <span className="shrink-0 rounded-full bg-background-secondary-default px-1.5 not-italic text-text-tertiary">
      {t("threadTimeline.askUserDismissed")}
    </span>
  );
}
