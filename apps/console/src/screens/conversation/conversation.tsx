import { ConversationFiles } from "../../components/conversation-files";
import { ConversationDiagnostic } from "../../components/conversation-diagnostic";
import { isRestoredQueryData } from "../../lib/query-persister";
import { useWorkspaceConversationDraft } from "../../lib/workspace/workspace-draft";
import { usePublishRunInProgress } from "../../lib/run/run-in-progress";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { botAccentColor, botBubbleColor, botTintStyle, botUserBubbleFill } from "../../lib/bots/bot-tint";
import { useBotAccentMode } from "../../lib/bots/bot-accent-preference";
import type { MessageAuthorBot, CreateMessageVersionInput, MessageVersionLinkDto } from "@openedbot/contracts-api";
import { replyPreviewSnippet, replyQuoteText, type MessageReactionEmoji } from "@openedbot/conversation/domain/message-reply";
import type { MentionableBot } from "@openedbot/roster/domain/mentions";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { conversationHref } from "../../lib/thread/conversation-href";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconSettings, IconShieldLock, IconX } from "@tabler/icons-react";
import { Button, Dialog, useIsMobile } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys, userFacingError, runtimesQueryOptions } from "../../lib/api";
import { applySendAcceptedToCaches } from "../../lib/thread/apply-send-accepted";
import { useThreadMessageSend } from "../../lib/thread/use-thread-message-send";
import { randomId } from "../../lib/random-id";
import { displayedRuntimeHealth, isRuntimeUnavailableError, runtimeBlocksConversation } from "../../lib/runtime/runtime-health";
import {
  threadContainsOutgoingUserInput,
} from "../../lib/thread/thread-anchor";
import { useThreadStream } from "../../lib/stream/use-thread-stream";
import { useConnectedMcpPlugins } from "../../lib/runtime/use-mcp-plugins";
import { rememberBotThread } from "../../lib/thread/conversation-prefetch";
import { BotFace } from "../../components/bot-face";
import { useBotDialogs } from "../../lib/bots/bot-dialogs";
import { settledBotModelSaves } from "../../lib/bots/bot-model-saves";
import { Composer } from "../../components/composer";
import { ConversationAvailability } from "../../components/conversation-availability";
import { useRunFailureAtOpen } from "../../lib/run/run-failure-at-open";
import { RuntimeOfflineBadge, useRuntimeOfflineNotice } from "../../components/runtime-offline-notice";
import { BotProfileRepair, useBotProfileStatus } from "../../components/bot-profile-repair";
import { ComposerArrival, ThreadArrival, ThreadStartStage, threadStartShown } from "../../components/thread-start-stage";
import { ThreadTimeline } from "../../components/thread-timeline";
import { ThreadTurnRail } from "../../components/thread-turn-rail";
import { buildThreadRailTurns } from "../../lib/thread/thread-turn-rail";
import { WorkflowOverview } from "../../components/workflow-overview";
import { ThreadContextTab } from "../../components/thread-context-tab";
import { AttachmentCanvas, AttachmentCanvasProvider } from "../../components/attachment-canvas";
import { ThreadModelPicker } from "../../components/composer-model-picker";
import { SiteHeader } from "../../components/dashboard/site-header";
import { useOpenSettings } from "../../lib/shell/settings-overlay";
import { ConversationHeader } from "../../components/boardui/conversation-header";
import { useAgentEditor } from "../../lib/bots/agent-editor";
import { useThreadGoal, withThreadGoal } from "../../lib/thread/thread-goal";
import { PermissionModeBadge } from "../../components/boardui/permission-picker";
import { GoalDialog } from "../../components/boardui/goal-dialog";
import { ConversationPending, ThreadSkeleton } from "../../components/thread-skeleton";
import { parseAskUser } from "@openedbot/roster/domain/ask-user";
import { useDismissedAskUserRuns } from "../../lib/run/ask-user-dismissals";
import { visibleRosterItems } from "@/lib/thread/thread-visibility";
import { useT } from "../../lib/i18n";
import { readableRunFailure, runFailureExplainedInThread } from "../../lib/run/model-unavailable";
import { runProviderAuthLabel } from "../../lib/runtime/provider-auth";
import { latestRunFallback, sameRunFallback } from "../../lib/run/run-fallback";
import { currentThreadRun } from "../../lib/thread/current-thread-run";
import { useMarkThreadRead } from "../../lib/thread/use-mark-thread-read";
import { useThreadFind } from "../../lib/thread/use-thread-find";
import { ChromeIconButton } from "../../components/mobile/mobile-header";
import { SHOW_FEATURE_LAB } from "../../lib/thread/dev-approval-probe";
import { isStandaloneDisplay } from "../../lib/platform/pwa-display";
import { FeatureLabDialog } from "../../components/feature-lab-dialog";
import { PendingApprovalDock } from "../../components/gate-card";
import { useLiveApprovals, useTimelineMessages } from "../../lib/thread/timeline-inputs";
import { PendingPlanDock } from "../../components/plan-card";
import {
  PLAN_PREVIEW_EVENT,
  PLAN_PREVIEW_SOURCE,
  assistantEventText,
  dismissPlanPreview,
  messagesAfter,
  parsePlanDraft,
  planPreviewEnabled,
  readPlanTurn,
  textOfContent,
  usePlanFirst,
  writePlanTurn,
  type PlanTurn,
} from "../../lib/composer/plan-draft";
import { RunActivityDock } from "../../components/run-activity-dock";
import { DevRenderProfiler } from "../../components/dev/dev-render-profiler";
import { sameAuthorList, sameAuthorMap, sameValueMap, useContentStable } from "../../lib/hooks/use-content-stable";
import { BUTTON } from "../../components/settings/primitives";
export function ConversationScreen() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [standalone] = useState(isStandaloneDisplay);
  const { botId } = useParams({ strict: false }) as { botId?: string };
  const navigate = useNavigate();
  const openSettings = useOpenSettings();
  const queryClient = useQueryClient();
  // THIS bot's page (the reference app rows), mounted once by the frame.
  const openManage = useBotDialogs((state) => state.openManage);
  // The page reads the thread shown here (a `?task=` branch included), held
  // in a ref so these callbacks stay referentially stable for the timeline.
  const shownThreadIdRef = useRef<string | null>(null);
  const openBotManage = useCallback(() => {
    if (botId) openManage(botId, null, shownThreadIdRef.current);
  }, [botId, openManage]);
  const [featureLabOpen, setFeatureLabOpen] = useState(false);
  const openBotErrors = useCallback(() => {
    if (botId) openManage(botId, "skills", shownThreadIdRef.current);
  }, [botId, openManage]);
  const openBotApprovals = useCallback(() => {
    if (botId) openManage(botId, "approvals", shownThreadIdRef.current);
  }, [botId, openManage]);
  const draftScope = `bot:${botId}:${new URLSearchParams(window.location.search).get("task") ?? "default"}`;
  const { draft, setDraft, attachments, setAttachments, unpersisted } = useWorkspaceConversationDraft(draftScope);
  const [goal, setGoal] = useThreadGoal(`bot:${botId}`);
  const [goalOpen, setGoalOpen] = useState(false);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const clearReply = () => {
    setReplyToId(null);
    setReplyQuote(null);
  };
  const [editingMessage, setEditingMessage] = useState<{ id: string; text: string } | null>(null);
  const pendingVersion = useRef<{
    messageId: string;
    input: CreateMessageVersionInput;
    idempotencyKey: string;
  } | null>(null);

  const roster = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    refetchInterval: (query) => query.state.data?.bots.some((candidate) => candidate.profileProvisionStatus === "preparing") ? 600 : false,
  });
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const { task: requestedTaskId } = useSearch({ strict: false }) as { task?: string };
  const rosterBot = roster.data?.bots.find((candidate) => candidate.id === botId);
  // The MCP plugins this bot's profile reaches (the runtime's when the host does not
  // say): typing their name colors the word. Read reserved to `owner`/`admin` (see the hook).
  const mcpPlugins = useConnectedMcpPlugins(me.data?.session.role, rosterBot?.hermesProfile ?? null);
  const retryProfileProvision = useMutation({
    mutationFn: () => api.retryBotProfileProvision(botId ?? ""),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.roster }); },
  });
  const botUnavailable = Boolean(rosterBot && rosterBot.archivedAt !== null);
  const bot = botUnavailable ? undefined : rosterBot;
  // The user's bubbles take the bot's color, if its face has one.
  const bubbleColor = useMemo(() => botBubbleColor(bot?.id, bot?.face), [bot?.id, bot?.face]);
  // …and, unless set otherwise, the column accent (buttons,
  // switches, focus): a grey does not become one (`botAccentColor`).
  const botAccentMode = useBotAccentMode();
  const accentColor = botAccentMode === "bot" ? botAccentColor(bubbleColor) : null;
  const userFill = botUserBubbleFill(bot?.id, bot?.face);
  const tintStyle = useMemo(() => botTintStyle(bubbleColor, userFill), [bubbleColor, userFill]);
  // A kept URL must not reopen a bot that has left the active roster. Deletion
  // is a soft delete (so the row stays in the roster for
  // Settings → Archives): `archivedAt` must be judged, not only the absence
  // of the row. `replace` stops Back from reopening the same URL at once.
  useEffect(() => {
    if (botUnavailable) void navigate({ to: "/", replace: true });
  }, [botUnavailable, navigate]);
  // One bot, one thread: `bot.threadId` IS the conversation. `?task=` no longer
  // names an extra session: they no longer exist: but a message-variant
  // branch, whose tenancy is already checked by the thread
  // route: a foreign id answers 404 there, there is nothing to validate here.
  const activeThreadId = requestedTaskId ?? bot?.threadId;
  shownThreadIdRef.current = activeThreadId ?? null;
  // The route loader starts this thread on the next refresh without waiting
  // for the roster (`lib/thread/conversation-prefetch.ts`).
  useEffect(() => {
    if (bot?.id && bot.threadId) rememberBotThread(bot.id, bot.threadId);
  }, [bot?.id, bot?.threadId]);

  const { thread, streaming, loading, loadOlder, loadingOlder, olderError, liveText } = useThreadStream(activeThreadId);
  // Opening another bot closes the editor instead of carrying its canvas over.
  const releaseEditor = useAgentEditor((state) => state.release);
  useLayoutEffect(() => {
    releaseEditor();
    return releaseEditor;
  }, [botId, releaseEditor]);
  const closeConversation = () => {
    releaseEditor();
    void navigate({ to: "/" });
  };
  const [submissionError, setSubmissionError] = useState<unknown>(null);
  const [dismissedError, setDismissedError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const runtimes = useQuery({
    ...runtimesQueryOptions(),
    refetchOnWindowFocus: true,
  });
  const runtime = runtimes.data?.runtimes[0];
  const runtimeHealth = displayedRuntimeHealth(runtime);
  const runtimeUnavailable = runtimeBlocksConversation(runtime, runtimes.isSuccess);
  // Link known to be closed: both reads below can only answer 503, so they do
  // not refetch on their own (focus, remount). The offline banner's retry
  // still calls `refetch()`, which ignores `enabled`.
  const linkClosed = runtimeHealth === "disconnected";
  // Observe the same catalogue as the picker, including in standalone mode.
  const runtimeModels = useQuery({
    queryKey: queryKeys.runtimeModels(runtime?.id ?? "none"),
    queryFn: () => api.runtimeModels(runtime!.id!),
    enabled: Boolean(bot && runtime?.id) && !linkClosed,
    refetchOnWindowFocus: true,
  });
  // Runtime replaced: the profile named by the bot no longer exists on the host.
  const profileStatus = useBotProfileStatus(bot, !linkClosed);
  const profileMissing = profileStatus.data?.state === "missing";
  const blockingError = roster.error ?? me.error ?? thread.error ??
    runtimes.error ?? runtimeModels.error ?? submissionError;
  const conversationBlocked = (Boolean(blockingError) && blockingError !== dismissedError) || runtimeUnavailable || retrying;
  const conversationErrorMessage = runtimeUnavailable && !runtime ? t("mvp.noMachine") : runtimeUnavailable && runtimeHealth === "disconnected"
    ? t("conversation.linkUnavailable")
    : blockingError instanceof ApiError &&
    blockingError.code === "RUNTIME_LINK_UNAVAILABLE"
    ? t("conversation.linkUnavailable")
    : userFacingError(blockingError, t("conversation.loadFailed"));
  const hostUnavailable = isRuntimeUnavailableError(blockingError);
  const runtimeOffline =
    (runtimeUnavailable &&
      (runtimeHealth === "disconnected" || runtimeHealth === "unreachable") &&
      (!blockingError || hostUnavailable || blockingError === dismissedError)) ||
    (hostUnavailable && blockingError !== dismissedError);
  const openRuntimeSettings = () => openSettings("/settings/runtime");
  const requireRuntime = () => {
    if (blockingError) throw blockingError;
    if (retrying) throw new Error(conversationErrorMessage);
    if (!runtime) throw new ApiError(409, t("mobileSettingsRuntimes.registryEmpty"), "RUNTIME_MISSING");
  };
  const retryConversation = async () => {
    setRetrying(true);
    try {
      await Promise.all([
        roster.refetch(), me.refetch(), runtimes.refetch(),
        ...(activeThreadId ? [thread.refetch()] : []),
        ...(runtime?.id ? [runtimeModels.refetch()] : []),
      ]);
      setSubmissionError(null);
    } finally {
      setRetrying(false);
    }
  };
  const runtimeNotice = useRuntimeOfflineNotice({
    offline: runtimeOffline,
    since: runtime?.link?.lastSeenAt,
    retrying,
    onRetry: () => void retryConversation(),
    onOpenRuntime: openRuntimeSettings,
  });
  useEffect(() => {
    if (!conversationBlocked) return;
    setEditingMessage(null);
    const field = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]");
    field?.blur();
  }, [conversationBlocked]);

  const versions = useQuery({
    queryKey: queryKeys.messageVersions(activeThreadId ?? "none"),
    queryFn: () => api.messageVersions(activeThreadId!),
    enabled: Boolean(activeThreadId),
  });
  const versionFamilyByMessage = useMemo(
    () => new Map((versions.data?.families ?? []).map((family) => [family.currentMessageId, family] as const)),
    [versions.data?.families],
  );
  useMarkThreadRead(
    activeThreadId,
    thread.data?.id === activeThreadId ? thread.data : null,
  );

  // Bot mode: the bots reachable by `@slug`: every one in the roster except
  // the thread's (the cloud API ignores a self-mention anyway).
  // Memoized: the timeline uses them for its chips and its bubbles are `memo`.
  // Content-stable: every roster patch (202, read receipt, SSE
  // flush) rebuilds `roster.data`; a new array with the same bots re-ran the
  // thread model and every turn signature for nothing.
  const mentionables = useContentStable(useMemo<MentionableBot[]>(
    () =>
      visibleRosterItems(roster.data?.bots ?? [])
        .filter((candidate) => !candidate.archivedAt && candidate.id !== bot?.id)
        .map(({ id, name, slug, face }) => ({ id, name, slug, face })),
    [roster.data, bot?.id],
  ), sameAuthorList);
  const threadFind = useThreadFind({
    runs: thread.data?.runs,
    messages: thread.data && thread.data.id === activeThreadId ? thread.data.messages : [],
    events: thread.data && thread.data.id === activeThreadId ? thread.data.events : [],
    mentionables,
    operatorUsername: roster.data?.operator?.username ?? null,
  });

  // A DM is not single-speaker: a delegated step is run by
  // ANOTHER bot in the roster. Without this run -> author map, its bubble borrowed
  // the thread bot's face and name: Neo's reply signed Scout.
  // Both Maps are rebuilt by every run status change and roster patch; the
  // timeline only needs a new reference when an author or a voice changed.
  const runAuthors = useContentStable(useMemo(() => {
    const map = new Map<string, MessageAuthorBot>();
    for (const run of thread.data?.runs ?? []) {
      if (!run.botId) continue;
      const author = roster.data?.bots.find((candidate) => candidate.id === run.botId);
      if (author) map.set(run.id, { id: author.id, name: author.name, slug: author.slug, face: author.face });
    }
    return map;
  }, [thread.data?.runs, roster.data?.bots]), sameAuthorMap);
  const speechVoiceByBotId = useContentStable(useMemo(
    () => new Map((roster.data?.bots ?? []).map((candidate) => [candidate.id, candidate.voiceId] as const)),
    [roster.data?.bots],
  ), sameValueMap);

  const send = useThreadMessageSend({
    threadId: activeThreadId,
    draft: { input: draft, attachments, replyToId },
    beforeSend: async () => {
      requireRuntime();
      // The model or effort choice being saved, made here or
      // on the bot's page: the send waits for it (a few milliseconds) instead
      // of being blocked, and leaves with it.
      await settledBotModelSaves(botId);
    },
    clearDraft: () => {
      setDraft("");
      setAttachments([]);
      clearReply();
    },
    restoreDraft: (payload) => {
      setDraft(payload.input);
      setAttachments(payload.attachments);
      if (payload.replyToId) setReplyToId(payload.replyToId);
    },
    onError: (error) => {
      setDismissedError(null);
      setSubmissionError(error);
    },
  });
  const outgoingUser = send.outgoing;
  // `send.retry` changes identity with `isPending`: passed as is, it re-rendered
  // the memoized thread on the send tick and again on the 202 tick.
  const sendRetryRef = useRef(send.retry);
  sendRetryRef.current = send.retry;
  const retryOutgoing = useCallback(() => sendRetryRef.current(), []);
  const [planFirst, setPlanFirst] = usePlanFirst(draftScope);
  const [planTurn, setPlanTurn] = useState<PlanTurn | null>(null);
  const [planPreview, setPlanPreview] = useState(false);
  const commitPlanTurn = useCallback((next: PlanTurn | null) => {
    if (activeThreadId) writePlanTurn(activeThreadId, next);
    setPlanTurn(next);
  }, [activeThreadId]);

  useEffect(() => {
    setPlanTurn(activeThreadId ? readPlanTurn(activeThreadId) : null);
  }, [activeThreadId]);

  useEffect(() => {
    const sync = () => setPlanPreview(planPreviewEnabled());
    sync();
    window.addEventListener(PLAN_PREVIEW_EVENT, sync);
    return () => window.removeEventListener(PLAN_PREVIEW_EVENT, sync);
  }, [activeThreadId]);

  useEffect(() => {
    setDismissedError(null);
    setSubmissionError(null);
    pendingVersion.current = null;
    clearReply();
    setEditingMessage(null);
    // The failure belongs to the thread that produced it: without this reset, the
    // « Le message n'est pas parti » alert followed the operator onto the next
    // conversation, where nothing justified it anymore.
    send.reset();
  }, [activeThreadId]);

  const createVersion = useMutation({
    mutationFn: (payload: { messageId: string; input: CreateMessageVersionInput }) => {
      if (conversationBlocked) throw blockingError ?? new Error(conversationErrorMessage);
      const saved = pendingVersion.current;
      const idempotencyKey = saved && saved.messageId === payload.messageId &&
        JSON.stringify(saved.input) === JSON.stringify(payload.input)
        ? saved.idempotencyKey
        : randomId();
      pendingVersion.current = { ...payload, idempotencyKey };
      return api.createMessageVersion(activeThreadId!, payload.messageId, payload.input, idempotencyKey);
    },
    onSuccess: async (created) => {
      pendingVersion.current = null;
      setEditingMessage(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.messageVersions(activeThreadId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
      ]);
      await navigate({
        ...conversationHref(bot!, {
          threadId: created.branchThreadId,
          isDefault: created.branchThreadId === bot!.threadId,
        }),
      });
    },
  });

  const expectedVersionCount = (messageId: string) =>
    versionFamilyByMessage.get(messageId)?.versions.length ?? 1;
  // These three go to the thread (`memo`): a fresh identity on every keystroke
  // of the composer would be enough to make it rebuild everything. They read messages and
  // versions by ref: depending on `thread.data?.messages` changed their
  // identity on every 202 and emptied the per-turn cache of the thread (measured at 396 ms).
  const threadMessagesRef = useRef(thread.data?.messages);
  threadMessagesRef.current = thread.data?.messages;
  const versionFamilyRef = useRef(versionFamilyByMessage);
  versionFamilyRef.current = versionFamilyByMessage;
  const beginEdit = useCallback((messageId: string) => {
    const message = threadMessagesRef.current?.find((candidate) => candidate.id === messageId);
    if (!message) return;
    const text = message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
    setEditingMessage({ id: messageId, text });
  }, []);
  const regenerate = useCallback((messageId: string) => createVersion.mutate({
    messageId,
    input: {
      mode: "regenerate",
      expectedVersionCount: versionFamilyRef.current.get(messageId)?.versions.length ?? 1,
    },
  }), [createVersion.mutate]);
  // `bot` is a roster row, recreated on every patch (202, stream): read by ref.
  const botRef = useRef(bot);
  botRef.current = bot;
  const selectMessageVersion = useCallback((version: MessageVersionLinkDto) => {
    const current = botRef.current;
    if (!current) return;
    void navigate({
      ...conversationHref(current, {
        threadId: version.threadId,
        isDefault: version.threadId === current.threadId,
      }),
    });
  }, [navigate]);

  const reaction = useMutation({
    mutationFn: ({ messageId, emoji, active }: {
      messageId: string;
      emoji: MessageReactionEmoji;
      active: boolean;
    }) => active
      ? api.removeMessageReaction(activeThreadId!, messageId, emoji)
      : api.addMessageReaction(activeThreadId!, messageId, emoji),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(activeThreadId!) });
    },
  });

  const replyMessage = thread.data?.messages.find((message) => message.id === replyToId) ?? null;
  const replyAuthor = replyMessage
    ? replyMessage.authorBot?.name ?? replyMessage.authorBot?.slug ??
      (replyMessage.role === "assistant" ? bot?.name ?? t("threadTimeline.assistant") : t("threadTimeline.operator"))
    : null;
  const replyPreview = replyMessage && replyAuthor
    ? {
        author: replyAuthor,
        text: replyPreviewSnippet(replyQuote ?? replyQuoteText(replyMessage.content)),
      }
    : null;
  const selectReply = useCallback((messageId: string, quote?: string) => {
    if (!threadMessagesRef.current?.some((message) => message.id === messageId)) return;
    setReplyToId(messageId);
    setReplyQuote(quote?.trim() || null);
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")?.focus();
    });
  }, []);

  /**
   * The thread props, stabilized.
   *
   * `ThreadTimeline` is under `memo`: an array or a lambda recreated on
   * every render would make it re-render on EVERY composer keystroke: that is
   * exactly the typing latency we were after. A literal `?? []` at the
   * call site is enough to break the comparison, hence these memos.
   */
  const timelineEvents = useMemo(() => thread.data?.events ?? [], [thread.data?.events]);
  const timelineMessages = useTimelineMessages(thread.data?.messages, thread.data?.runs);
  const timelineApprovals = useLiveApprovals(thread.data?.approvals, thread.data?.runs);
  const timelineSettingProposals = useMemo(() => thread.data?.settingProposals ?? [], [thread.data?.settingProposals]);
  const timelineRuns = useMemo(() => thread.data?.runs ?? [], [thread.data?.runs]);
  // The header names who REALLY served the last turn when it was re-routed
  // (Bug 2, 2026-10-24: "grok-4.6 Medium" over an Anthropic answer). Stable
  // by content: a streaming delta rebuilds `events` and must not re-render
  // the model picker.
  const lastTurnFallback = useContentStable(
    useMemo(() => (bot ? latestRunFallback(timelineRuns, timelineEvents, bot.id) : null), [timelineRuns, timelineEvents, bot?.id]),
    sameRunFallback,
  );
  const timelineDefaultAuthor = useMemo<MessageAuthorBot | null>(
    () => (bot ? { id: bot.id, name: bot.name, slug: bot.slug, face: bot.face ?? null } : null),
    [bot?.id, bot?.name, bot?.slug, bot?.face],
  );
  // Snapshot only. The pending bubble is a sibling of the memoized entries
  // (`outgoing` on ThreadTimeline): folding it into this array rebuilt the
  // whole thread on every `isPending` flip (~500 ms before the POST left).
  const timelineUserInputs = useMemo(
    () => {
      const inputs = [];
      for (const message of timelineMessages) {
        if (message.role !== "user") continue;
        const textParts: string[] = [];
        const attachments = [];
        for (const part of message.content) {
          if (part.type === "text") textParts.push(part.text);
          else if (part.type === "attachment") attachments.push(part);
        }
        inputs.push({
          id: message.id,
          clientSubmissionId: message.clientSubmissionId,
          runId: message.runId,
          authorBot: message.authorBot ?? null,
          createdAt: message.createdAt,
          text: textParts.join(""),
          attachments,
        });
      }
      return inputs;
    },
    [timelineMessages],
  );
  const railTurns = useMemo(
    () => !isMobile ? buildThreadRailTurns(timelineMessages, timelineUserInputs) : [],
    [isMobile, timelineMessages, timelineUserInputs],
  );
  // Same condition as the rail: the thread and the activity then share the 3.5rem gutter.
  const turnRailShown = !isMobile && railTurns.length >= 2;
  const timelineOutgoing = outgoingUser &&
    !threadContainsOutgoingUserInput(timelineUserInputs, outgoingUser)
    ? outgoingUser
    : null;
  useEffect(() => {
    if (outgoingUser && !timelineOutgoing) send.clearOutgoing();
  }, [outgoingUser, timelineOutgoing]);
  const onReaction = useCallback(
    (messageId: string, emoji: MessageReactionEmoji, active: boolean) =>
      reaction.mutateAsync({ messageId, emoji, active }),
    [reaction.mutateAsync],
  );

  // A snapshot read back from IndexedDB paints the messages, never a live run:
  // its run may have ended hours ago, and a stop control on it would cancel a
  // run that no longer exists. The fresh snapshot follows within a request.
  const activeRun = isRestoredQueryData(thread.data) ? undefined : currentThreadRun(thread.data?.runs ?? []);
  // `queued` counts: between the send and the worker taking it, the thread is already
  // busy: without it, neither an activity indicator nor a stop button during the wait.
  const running =
    activeRun?.status === "running" ||
    activeRun?.status === "starting" ||
    activeRun?.status === "queued" ||
    activeRun?.status === "pending";
  usePublishRunInProgress(running);
  const cancel = useMutation({
    mutationFn: () => api.cancelRun(activeRun!.id),
    // The snapshot may have changed between showing the button and the POST
    // (Hermes finished, or another worker already reconciled). Rereading the thread
    // in both cases avoids leaving « le run continue » on a stale state.
    onSettled: () => {
      if (activeThreadId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.thread(activeThreadId) });
      }
    },
  });

  useEffect(() => {
    if (!running && cancel.isError) cancel.reset();
  }, [cancel.isError, running]);

  // Surface asynchronous runtime failures once per run, including failures
  // reported after the message POST succeeded (SSE + polling).
  const notifiedFailedRunId = useRef<string | null>(null);
  // Read when the failure fires, never a dependency: a streaming delta
  // rebuilds the events and must not re-run this once-per-run effect.
  const failureEventsRef = useRef(thread.data?.events);
  failureEventsRef.current = thread.data?.events;
  // A failure older than this visit is told by its notice in the thread.
  const failedRunAtOpen = useRunFailureAtOpen(activeThreadId, Boolean(thread.data) && !isRestoredQueryData(thread.data), activeRun);
  useEffect(() => {
    if (activeRun?.status !== "failed" || activeRun.id === notifiedFailedRunId.current) return;
    if (activeRun.id === failedRunAtOpen) return;
    notifiedFailedRunId.current = activeRun.id;
    if (bot?.id) void queryClient.invalidateQueries({ queryKey: queryKeys.botProfileStatus(bot.id) });
    // Profile missing from the runtime: the repair notice already says what to do.
    if (profileMissing) return;
    // A refused model or provider login: its notice in the thread names the
    // fix and carries the action. A blocking modal would hide it.
    if (runFailureExplainedInThread(activeRun, failureEventsRef.current)) return;
    setDismissedError(null);
    setSubmissionError(new ApiError(
      502,
      readableRunFailure(t, activeRun, bot?.name ?? t("threadTimeline.unknownBot"), runProviderAuthLabel(failureEventsRef.current, activeRun.id))
        ?? activeRun.error
        ?? t("threadTimeline.runtimeErrorFallback"),
      "RUNTIME_RUN_FAILED",
    ));
  }, [activeRun?.id, activeRun?.status, activeRun?.error, activeRun?.errorCode, failedRunAtOpen, t, bot?.id, profileMissing, queryClient]);

  // A pending gate blocks the composer: letting one type while a
  // decision is due would give the illusion that the bot can continue without it.
  const pendingGate = timelineApprovals.length > 0;

  // Until the card is launched, a send is a plan correction,
  // not an execution. The worker decides the gates of these turns as in
  // Plan mode (`planOnly`); reads stay allowed.
  useEffect(() => {
    if (!activeThreadId || !planTurn) return;
    // Leaving the plan without clearing the turn reopens it on the next switch:
    // the card starts again on the old plan. The execution, itself, is no longer a card.
    if (!planFirst || bot?.permissionMode === "plan") {
      commitPlanTurn(null);
      return;
    }
    const messages = thread.data?.id === activeThreadId ? thread.data.messages : undefined;
    if (!messages) return;

    if (planTurn.phase === "awaiting") {
      const liveRunId = planTurn.runId ?? (
        activeRun && activeRun.status !== "completed" && activeRun.status !== "failed" && activeRun.status !== "cancelled"
          ? activeRun.id
          : null
      );
      const assistant = [...messagesAfter(messages, planTurn.anchorMessageId)]
        .reverse()
        .find((message) => message.role === "assistant");
      if (assistant && !running) {
        commitPlanTurn({
          phase: "pending",
          anchorMessageId: planTurn.anchorMessageId,
          messageId: assistant.id,
          runId: assistant.runId,
        });
        return;
      }
      if (liveRunId && liveRunId !== planTurn.runId) commitPlanTurn({ ...planTurn, runId: liveRunId });
      return;
    }

    if (planTurn.phase === "executing" && !running && !send.isPending) {
      const after = messagesAfter(messages, planTurn.anchorMessageId);
      if (after.some((message) => message.role === "assistant")) {
        commitPlanTurn(null);
        return;
      }
      if (activeRun?.status === "failed" || activeRun?.status === "cancelled") {
        commitPlanTurn({ ...planTurn, phase: "pending" });
      }
    }
  }, [activeThreadId, planTurn, thread.data, running, activeRun, planFirst, bot?.permissionMode, send.isPending, commitPlanTurn]);
  // Data passed to the thread, not a conditional callback: see the comment
  // on `onEditMessage`/`onRegenerateMessage` below.
  const canEditMessages = me.data?.session.canWrite === true && !running && !pendingGate &&
    !createVersion.isPending;

  // ask_user: the question that ENDS the last completed turn. The run's
  // output is the source (not the timeline): as soon as the operator answers, the
  // last run becomes that answer and the panel drops on its own.
  // The card lives in the thread (`AskUserCard`): its callback keeps a stable
  // identity (global context of the turn cache) and reads the send by ref.
  const sendRef = useRef(send);
  sendRef.current = send;
  const pickAskUser = useCallback((text: string) => {
    if (!sendRef.current.isPending) sendRef.current.mutate({ input: text, attachments: [] });
  }, []);
  // The card's "x" dismisses the question: it folds back into the thread.
  const dismissedAskUserRuns = useDismissedAskUserRuns();
  const askUser =
    !running && !pendingGate && activeRun?.status === "completed" && activeRun.output &&
    !dismissedAskUserRuns.includes(activeRun.id)
      ? parseAskUser(activeRun.output, roster.data?.operator ?? null)
      : null;
  // The route can change before React Query has installed the new snapshot.
  // Treat a snapshot for another thread as stale so the previous conversation
  // can never flash during a bot switch.
  const threadLoading = loading || thread.data?.id !== activeThreadId;
  const threadFailed = thread.isError && thread.data?.id !== activeThreadId;
  const threadFailureMessage = thread.error instanceof ApiError &&
    thread.error.code === "DATABASE_MIGRATION_REQUIRED"
    ? t("conversation.migrationRequired")
    : t("conversation.loadFailed");

  // The lab stays readable even while the thread is working: the
  // header button always opens the box, but the CTA explains why
  // a second run cannot leave yet.
  const featureLabBlockedReason = conversationBlocked
    ? conversationErrorMessage
    : threadLoading
      ? t("featureLab.threadUnavailable")
      : pendingGate
        ? t("featureLab.decisionPending")
        : running || send.isPending
          ? t("featureLab.botBusy")
          : undefined;
  const launchFeatureScenario = (prompt: string) => {
    if (featureLabBlockedReason) return;
    setFeatureLabOpen(false);
    send.mutate({ input: prompt, attachments: [] });
  };

  if (!bot) {
    if (roster.isPending) return <ConversationPending />;
    if (botUnavailable) return null;
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {roster.error ? userFacingError(roster.error, t("conversation.loadFailed")) : t("conversation.botGone")}
      </div>
    );
  }

  // « Planifier d'abord »: an intention of THIS thread, sent with every
  // message (`planOnly`). A bot already in Plan mode (its profile) plans
  // everywhere: the intention adds nothing there, and Lancer would not execute there.
  const planMode = planFirst && bot.permissionMode !== "plan";
  // Profile being prepared: the API refuses any model change (409
  // BOT_PROFILE_PREPARING) and the next message would leave on the old one. The
  // picker therefore waits for preparation to finish (the roster is reread every 0.6 s).
  const provisioning = bot.profileProvisionStatus === "preparing";
  const starting = threadStartShown({ provisioning, runs: timelineRuns });
  const threadView = thread.data?.id === activeThreadId ? thread.data : undefined;
  const threadMessages = threadView?.messages ?? [];
  const planAnchor = threadMessages.at(-1)?.id ?? null;
  const freshAssistant = planTurn
    ? [...messagesAfter(threadMessages, planTurn.anchorMessageId)].reverse().find((message) => message.role === "assistant")
    : undefined;
  const heldAssistant = planTurn?.messageId
    ? threadMessages.find((message) => message.id === planTurn.messageId)
    : undefined;
  const planSource = textOfContent((freshAssistant ?? heldAssistant)?.content ?? [])
    || assistantEventText(threadView?.events ?? [], planTurn?.runId ?? freshAssistant?.runId ?? null);
  const realPlanOpen = planMode && (planTurn?.phase === "awaiting" || planTurn?.phase === "pending");
  const previewOpen = planMode && planPreview && !realPlanOpen;
  const planOpen = realPlanOpen || previewOpen;
  const planDraft = parsePlanDraft(realPlanOpen ? planSource : previewOpen ? PLAN_PREVIEW_SOURCE : "");
  const planWriting = realPlanOpen && !planSource.trim();
  // A plan turn that ends on a question (`@user ...` + options)
  // has no plan: the bubble and the question card take the dock's
  // place, and Lancer is not offered until a plan exists.
  const planQuestion = realPlanOpen && !planWriting &&
    (askUser !== null || parseAskUser(planSource, roster.data?.operator ?? null) !== null);
  const planDockOpen = planOpen && !planQuestion;
  // Hide the bubble only once the card already has the text. Before that, the
  // thread has neither bubble nor card: a hole, then the content reappearing.
  const hiddenAssistantRunIds = realPlanOpen && !planWriting && !planQuestion
    ? [planTurn?.runId, freshAssistant?.runId, heldAssistant?.runId].filter((id): id is string => Boolean(id)).join(",")
    : "";
  const beginPlanTurn = () => {
    if (!planMode || !activeThreadId) return;
    if (planPreview) {
      dismissPlanPreview();
      setPlanPreview(false);
    }
    commitPlanTurn({
      phase: "awaiting",
      anchorMessageId: planAnchor,
      messageId: planTurn?.messageId ?? null,
      runId: null,
    });
  };
  const launchPlan = () => {
    // The plan is a parenthesis of the thread: Lancer closes it and the execution
    // leaves without `planOnly`, under the bot's mode. The bot itself never
    // changed mode.
    if (!realPlanOpen) {
      dismissPlanPreview();
      setPlanPreview(false);
      return;
    }
    if (send.isPending || conversationBlocked || pendingGate || planWriting || planQuestion) return;
    commitPlanTurn(null);
    setPlanFirst(false);
    send.mutate({
      input: withThreadGoal(t("planCard.executePrompt"), goal, t("boardui.goalPrefix")),
      attachments: [],
      replyToId: null,
    });
  };
  const editPlan = () => {
    const lines = [
      ...(planDraft.objective ? [planDraft.objective] : []),
      ...planDraft.steps.map((step, index) => `${index + 1}. ${step}`),
      ...(planDraft.note.trim() ? [planDraft.note.trim()] : []),
    ];
    setDraft(lines.join("\n"));
    requestAnimationFrame(() => {
      const field = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]");
      if (!field) return;
      field.focus();
      const end = field.value.length;
      field.setSelectionRange(end, end);
    });
  };

  const header = (
      <SiteHeader
        /* The title carries a face and a name: it stays pinned to the left. */
        align="start"
        avatar={<BotFace name={bot.name} seed={bot.id} face={bot.face} className={isMobile ? "size-9" : "size-5"} />}
        title={<span className="truncate">{bot.name}</span>}
        /*
          Phone: the line under the name says which model the bot answers on,
          like a contact's « en ligne ». The context gauge has only one
          place, the status line under the composer (DESIGN.md): repeating
          it here made two pills for the same measurement.
        */
        subtitle={isMobile ? (
          <div data-thread-subtitle="" className="flex min-w-0 items-center gap-1.5 text-[13px] leading-4 text-muted-foreground">
            {standalone ? null : (
              <ThreadModelPicker
                key={bot.id}
                bot={bot}
                variant="inline"
                servedBy={lastTurnFallback}
                disabled={threadLoading || pendingGate || conversationBlocked || !!bot.profileImportStatus || profileMissing || provisioning}
              />
            )}
            <PermissionModeBadge bot={bot} onOpen={openBotApprovals} compact />
          </div>
        ) : undefined}
        actions={
          <>
            {/* The durable state of the work in progress: a button, not a band
                pinned above the thread (see `WorkflowOverview`). */}
            {!threadLoading && thread.data ? (
              <WorkflowOverview
                threadId={thread.data.id}
                workflows={thread.data.workflows}
                runs={thread.data.runs}
              />
            ) : null}
            {thread.data ? <ConversationFiles key={thread.data.id} threadId={thread.data.id} botId={bot.id} /> : null}
            {/* Gear: this bot's config, in a sectioned modal. */}
            {isMobile ? (
              <ChromeIconButton
                label={t("conversation.botSettings", { name: bot.name })}
                icon={IconSettings}
                onClick={openBotManage}
              />
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-8"
                iconOnly
                leadingIcon={IconSettings}
                aria-label={t("conversation.botSettings", { name: bot.name })}
                title={t("conversation.botSettings", { name: bot.name })}
                onClick={openBotManage}
              />
            )}
            <ChromeIconButton label={t("notFound.home")} icon={IconX} onClick={closeConversation} />
          </>
        }
      />
  );


  // The last measured turn: next to the composer’s model on desktop,
  // under the composer on a phone.
  const contextMeter = bot && thread.data?.runs.length ? (
    <ThreadContextTab
      variant="status"
      runs={thread.data.runs}
      events={thread.data.events}
      botModel={thread.data.effectiveModel?.trim() || bot.model}
      hermesProfile={bot.hermesProfile}
    />
  ) : undefined;

  return (
    <AttachmentCanvasProvider>
      {isMobile ? header : null}
      {SHOW_FEATURE_LAB ? (
        <FeatureLabDialog
          open={featureLabOpen}
          botName={bot.name}
          disabledReason={featureLabBlockedReason}
          onClose={() => setFeatureLabOpen(false)}
          onLaunch={launchFeatureScenario}
        />
      ) : null}
      <Dialog
        open={editingMessage !== null}
        onClose={() => setEditingMessage(null)}
        title={t("conversation.editMessageTitle")}
        description={t("conversation.editMessageDescription")}
        closeLabel={t("common.close")}
        className="max-w-lg"
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!editingMessage?.text.trim()) return;
            createVersion.mutate({
              messageId: editingMessage.id,
              input: {
                mode: "edit",
                input: editingMessage.text.trim(),
                expectedVersionCount: expectedVersionCount(editingMessage.id),
              },
            });
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t("conversation.editMessageLabel")}
            <textarea
              value={editingMessage?.text ?? ""}
              onChange={(event) => setEditingMessage((current) => current
                ? { ...current, text: event.target.value }
                : current)}
              rows={6}
              maxLength={100_000}
              autoFocus
              className="min-h-32 resize-y rounded-lg border bg-background px-3 py-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          {createVersion.isError ? (
            <p role="alert" className="text-sm text-destructive-text">
              {userFacingError(createVersion.error, t("conversation.versionCreateFailed"))}
            </p>
          ) : null}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!editingMessage?.text.trim() || createVersion.isPending}
              className={BUTTON.primary}
            >
              {t("conversation.createVariant")}
            </button>
          </div>
        </form>
      </Dialog>

      {/* US-CHAT-08: the thread and the reading canvas share the row: a
          file opens BESIDE the conversation that talks about it, never
          on top of it, because one wants to consult it while reading that conversation. The
          panel takes space only when it is open. The composer stays
          IN the thread column: one writes to that thread, not to the file. */}
      {/* `relative`: on touch, the attachment canvas sits in
          `absolute inset-0` INSIDE this row: so in the geometry the
          shell takes from `visualViewport`, under the header and above the thread.
          Desktop: the header stays IN the thread column: otherwise its
          actions float above the open file. */}
      <div className="relative flex min-h-0 flex-1">
        {/* `data-thread-column`: messages, docks and composer center in
            a reading column (`--openedbot-thread-column`, thread-timeline.css).
            The row stays full width: the thread scroll keeps its
            bar at the window edge, the header its actions on the right. */}
        <div
          data-thread-column="" data-thread-solo=""
          data-bot-tint={bubbleColor ? "" : undefined}
          data-bot-accent={accentColor ? "" : undefined}
          style={tintStyle}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {isMobile ? null : (
            <DevRenderProfiler id="conversation-header"><ConversationHeader
              bot={bot}
              status={runtimeOffline ? (
                <RuntimeOfflineBadge
                  since={runtime?.link?.lastSeenAt}
                  retrying={retrying}
                  onClick={openRuntimeSettings}
                />
              ) : null}
              extra={(
                <>
                  {/* A mode out of the ordinary (Plan mode, Full
                      access) shows here, read-only: it is changed in the
                      bot's profile. On a phone, in the subtitle. */}
                  {thread.data ? <ConversationFiles key={thread.data.id} threadId={thread.data.id} botId={bot.id} /> : null}
                  <PermissionModeBadge bot={bot} onOpen={openBotApprovals} />
                  {!threadLoading && thread.data ? (
                    <WorkflowOverview
                      threadId={thread.data.id}
                      workflows={thread.data.workflows}
                      runs={thread.data.runs}
                    />
                  ) : null}
                  {SHOW_FEATURE_LAB ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-8"
                      iconOnly
                      leadingIcon={IconShieldLock}
                      aria-label={t("featureLab.open")}
                      title={t("featureLab.openHint")}
                      onClick={() => setFeatureLabOpen(true)}
                    />
                  ) : null}
                </>
              )}
            /></DevRenderProfiler>
          )}
{(runtimeUnavailable && !runtimeOffline) || Boolean(blockingError) || activeRun?.status === "failed" ? ( <ConversationDiagnostic floating code={blockingError instanceof ApiError ? blockingError.code : runtimeUnavailable ? "RUNTIME_MISSING" : activeRun?.errorCode} reference={activeRun?.id ?? thread.data?.id} onRetry={()=>void retryConversation()} retrying={retrying} onPermissions={openBotApprovals} /> ) : null}
        <ConversationAvailability
          modal
          onDismiss={() => {
            setDismissedError(blockingError);
            setSubmissionError(null);
          }}
          blocked={conversationBlocked && !runtimeOffline && !runtimeUnavailable}
          locked={profileMissing}
          message={conversationErrorMessage}
          retrying={retrying}
          onRetry={() => void retryConversation()}
        >
{thread.data && !timelineMessages.some(m=>m.role==="user") && !draft.trim() && attachments.length === 0 && !conversationBlocked && !provisioning && !starting ? ( <button type="button" className={`${BUTTON.small} mx-auto my-2`} onClick={()=>setDraft(t("mvp.firstPrompt"))}>{t("mvp.firstPromptAction")}</button> ) : null}
          <div data-thread-lane="" className="w-full px-4 pt-2 empty:hidden sm:px-6">
            {threadFind.bar}
          </div>
          {threadFailed ? (
            <div
              role="alert"
              className="flex w-full flex-1 flex-col items-center justify-center gap-3 px-4 text-center sm:px-6"
            >
              <p className="text-sm text-destructive-text">{threadFailureMessage}</p>
              <button type="button" onClick={() => void thread.refetch()} className={BUTTON.secondary}>
                {t("conversation.retry")}
              </button>
            </div>
          ) : threadLoading && !starting ? (
            <ThreadSkeleton />
          ) : <ThreadArrival bot={bot} status={bot.profileProvisionStatus}>{starting ? <ThreadStartStage bot={bot} /> : <div
            className="relative flex min-h-0 flex-1 flex-col"
            data-turn-rail={turnRailShown ? "" : undefined}
          >
          <DevRenderProfiler id="thread-timeline"><ThreadTimeline liveText={liveText}
            events={timelineEvents}
            messages={timelineMessages}
            userInputs={timelineUserInputs}
            outgoing={timelineOutgoing}
            onRetryOutgoing={retryOutgoing}
            mentionables={mentionables}
            runs={timelineRuns}
            runAuthors={runAuthors}
            defaultAuthor={timelineDefaultAuthor}
            approvals={timelineApprovals}
            settingProposals={timelineSettingProposals}
            running={running}
            truncated={thread.data?.truncated ?? false}
            hasOlderHistory={thread.data?.history?.hasMore ?? false}
            loadingOlder={loadingOlder}
            olderError={olderError}
            onLoadOlder={loadOlder}
            operatorUsername={roster.data?.operator?.username ?? null}
            activeAskUserRunId={askUser ? activeRun?.id ?? null : null}
            onAskUserPick={pickAskUser}
            activeFindTargetId={threadFind.activeTargetId}
            onReply={selectReply}
            messageVersionFamilies={versionFamilyByMessage}
            // `beginEdit`/`regenerate` always leave, stable identity: wrapping
            // them in a ternary on `running`/`pendingGate` flipped
            // the prop on every run start/end, and emptied the per-turn
            // cache of the thread (`turnNodeCache`, thread-timeline.tsx) for the WHOLE
            // thread. Availability now leaves as DATA
            // (`canEditMessages`), read per turn, not by the callback's
            // reference.
            onEditMessage={beginEdit}
            onRegenerateMessage={regenerate}
            onSelectMessageVersion={selectMessageVersion}
            onReaction={onReaction}
            onOpenBotErrors={openBotErrors}
            speechScope={bot.id}
            speechVoiceByBotId={speechVoiceByBotId}
            resnap={askUser !== null}
            scrollToBottomOnThreadKey={activeThreadId ?? null}
            canEditMessages={canEditMessages}
            hiddenAssistantRunIds={hiddenAssistantRunIds}
          /></DevRenderProfiler>
          {isMobile ? null : <ThreadTurnRail turns={railTurns} />}
          </div>}</ThreadArrival>}

          {cancel.isError ? (
            <p
              role="alert"
              data-thread-lane=""
              className="w-full shrink-0 px-4 text-sm text-destructive-text sm:px-6"
            >
              {t("threadScreen.stopFailed")}
            </p>
          ) : null}
          {createVersion.isError && !editingMessage ? (
            <p role="alert" data-thread-lane="" className="w-full shrink-0 px-4 text-sm text-destructive-text sm:px-6">
              {userFacingError(createVersion.error, t("conversation.versionCreateFailed"))}
            </p>
          ) : null}

          <PendingApprovalDock
            approvals={timelineApprovals}
            requester={bot.name}
          />

          {bot.profileImportStatus ? <p role="status" data-thread-lane="" className="px-4 text-sm sm:px-6">{t(bot.profileImportStatus === "needs_attention" ? "profileImport.status.needs_attention" : "profileImport.status.running")}</p> : null}
          {bot.profileProvisionStatus === "failed" ? (
            <div role="status" data-thread-lane="" className="flex items-center gap-3 px-4 text-sm sm:px-6">
              <p>{t("botProfileProvision.failed")}</p>
              <button type="button" className={BUTTON.small} disabled={retryProfileProvision.isPending} onClick={() => retryProfileProvision.mutate()}>
                {t("botProfileProvision.retry")}
              </button>
            </div>
          ) : null}
          {/* Profile being prepared: the center screen says so alone, with no thread
              and no composer (ThreadArrival, ComposerArrival); the dock stays quiet
              until the profile is ready. */}
          {provisioning ? null : <DevRenderProfiler id="run-activity-dock">
            <RunActivityDock
              runs={timelineRuns}
              events={timelineEvents}
              approvals={timelineApprovals}
              running={running}
              streaming={streaming}
              runAuthors={runAuthors}
              alignWithTurnRail={turnRailShown}
              statusInThread
            />
          </DevRenderProfiler>}
          {planDockOpen ? (
            <PendingPlanDock
              draft={planDraft}
              requester={bot.name}
              writing={planWriting}
              busy={send.isPending || pendingGate || conversationBlocked}
              onEdit={editPlan}
              onLaunch={launchPlan}
            />
          ) : null}
          <ComposerArrival bot={bot} status={bot.profileProvisionStatus}><DevRenderProfiler id="composer"><Composer
            attachmentScope={draftScope}
            draftUnpersisted={unpersisted}
            value={draft}
            onChange={(next) => {
              if (send.isError) send.reset();
              setDraft(next);
            }}
            onSubmit={() => {
              if (send.isPending || conversationBlocked) return;
              // Planifier d'abord: this field corrects the plan. Lancer is the
              // only send that allows execution; until then, the server
              // decides the turn's gates as in Plan mode (0155).
              if (planMode) beginPlanTurn();
              send.mutate({
                input: withThreadGoal(draft.trim(), goal, t("boardui.goalPrefix")),
                attachments,
                replyToId,
                planOnly: planMode,
              });
            }}
            onCancel={() => cancel.mutate()}
            botName={bot.name}
            disabled={threadLoading || pendingGate || runtimes.isPending || conversationBlocked || !!bot.profileImportStatus || profileMissing}
            // Gate: one says why. An in-flight send no longer grays the field
            // : the iOS keyboard must stay open.
            notice={runtimeNotice}
            // Offline, the status tab carries the sentence: the field only
            // says what it waits for, short enough not to be truncated.
            disabledReason={runtimeOffline
              ? t("runtimeOffline.composer")
              : runtimeUnavailable
              ? conversationErrorMessage
              : pendingGate
                ? t("conversation.pendingDecision")
                : undefined}
            running={running}
            sending={send.isPending}
            mentionables={mentionables}
            mcpPlugins={mcpPlugins}
            attachments={attachments}
            onAttachmentsChange={(next) => {
              if (send.isError) send.reset();
              setAttachments(next);
            }}
            modelControl={!isMobile && !standalone ? (
              <div className="flex shrink-0 items-center gap-1.5">
                <ThreadModelPicker
                  key={bot.id}
                  bot={bot}
                  variant="header"
                  servedBy={lastTurnFallback}
                  disabled={threadLoading || pendingGate || conversationBlocked || !!bot.profileImportStatus || profileMissing || provisioning}
                />
                {contextMeter}
              </div>
            ) : undefined}
            contextMeter={isMobile ? contextMeter : undefined}
            replyPreview={replyPreview}
            onCancelReply={clearReply}
            goal={goal}
            onSetGoal={() => setGoalOpen(true)}
            onClearGoal={() => setGoal(null)}
            planFirst={planMode}
            onPlanFirstChange={bot.permissionMode === "plan" ? undefined : (next) => {
              if (!next) commitPlanTurn(null);
              setPlanFirst(next);
            }}
            onManagePlugins={() => openSettings("/settings/connectors")}
            planPending={planDockOpen}
            onPlanLaunch={launchPlan}
          /></DevRenderProfiler></ComposerArrival>
          <GoalDialog
            open={goalOpen}
            initial={goal}
            onClose={() => setGoalOpen(false)}
            onSave={(next) => { setGoal(next); setGoalOpen(false); }}
          />
        </ConversationAvailability>
        {/* A missing profile blocks sending, but the operator can still return home. */}
        {profileMissing && profileStatus.data ? <BotProfileRepair bot={bot} status={profileStatus.data} onClose={closeConversation} /> : null}
        </div>
        <AttachmentCanvas />
      </div>
    </AttachmentCanvasProvider>
  );
}
