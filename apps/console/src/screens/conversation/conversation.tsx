import { isRestoredQueryData } from "../../lib/query-persister";
import { useWorkspaceTextDraft, useWorkspaceAttachmentDraft } from "../../lib/workspace/workspace-draft";
import { usePublishRunInProgress } from "../../lib/run/run-in-progress";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { botAccentColor, botBubbleColor, botTintStyle, botUserBubbleFill } from "../../lib/bots/bot-tint";
import { useBotAccentMode } from "../../lib/bots/bot-accent-preference";
import type { MessageAuthorBot } from "@openedbot/contracts-api";
import { replyPreviewSnippet, replyQuoteText, type MessageReactionEmoji } from "@openedbot/conversation/domain/message-reply";
import type { MentionableBot } from "@openedbot/roster/domain/mentions";
import type { CreateMessageVersionInput, MessageVersionLinkDto } from "@openedbot/contracts-api";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { conversationHref } from "../../lib/thread/conversation-href";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconSettings, IconShieldLock, IconX } from "@tabler/icons-react";
import { Button, Dialog, useIsMobile } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys, userFacingError, runtimesQueryOptions } from "../../lib/api";
import { applySendAcceptedToCaches } from "../../lib/thread/apply-send-accepted";
import { useThreadMessageSend } from "../../lib/thread/use-thread-message-send";
import { randomId } from "../../lib/random-id";
import { displayedRuntimeHealth, runtimeBlocksConversation } from "../../lib/runtime/runtime-health";
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
import { useSecondaryReadsReady } from "../../lib/shell/after-first-paint";
import { ChromeIconButton } from "../../components/mobile/mobile-header";
import { SHOW_FEATURE_LAB } from "../../lib/thread/dev-approval-probe";
import { isStandaloneDisplay } from "../../lib/platform/pwa-display";
import { FeatureLabDialog } from "../../components/feature-lab-dialog";
import { PendingApprovalDock } from "../../components/gate-card";
import { liveApprovals } from "../../lib/run/live-approvals";
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
  // La page de CE bot (rangées OpenBot), montée une fois par le cadre.
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
  const [draft, setDraft] = useWorkspaceTextDraft(draftScope);
  const [goal, setGoal] = useThreadGoal(`bot:${botId}`);
  const [goalOpen, setGoalOpen] = useState(false);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const clearReply = () => {
    setReplyToId(null);
    setReplyQuote(null);
  };
  /** Les pièces jointes du brouillon (US-CHAT-08), tenues ici pour la même
   *  raison que le texte : seul l'écran sait si l'envoi a abouti. */
  const [attachments, setAttachments] = useWorkspaceAttachmentDraft(draftScope);
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
  // Les plugins MCP branchés sur le runtime : écrire leur nom colore le mot
  // dans le composer. Lecture réservée aux `owner`/`admin` (voir le hook).
  const mcpPlugins = useConnectedMcpPlugins(me.data?.session.role);
  const { task: requestedTaskId } = useSearch({ strict: false }) as { task?: string };
  const rosterBot = roster.data?.bots.find((candidate) => candidate.id === botId);
  const retryProfileProvision = useMutation({
    mutationFn: () => api.retryBotProfileProvision(botId ?? ""),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.roster }); },
  });
  const botUnavailable = Boolean(rosterBot && rosterBot.archivedAt !== null);
  const bot = botUnavailable ? undefined : rosterBot;
  // Les bulles de l'utilisateur prennent la couleur du bot, si son visage en a une.
  const bubbleColor = useMemo(() => botBubbleColor(bot?.id, bot?.face), [bot?.id, bot?.face]);
  // …et, sauf réglage contraire, l'accent de la colonne (boutons,
  // interrupteurs, focus) : un gris n'en devient pas un (`botAccentColor`).
  const botAccentMode = useBotAccentMode();
  const accentColor = botAccentMode === "bot" ? botAccentColor(bubbleColor) : null;
  const userFill = botUserBubbleFill(bot?.id, bot?.face);
  const tintStyle = useMemo(() => botTintStyle(bubbleColor, userFill), [bubbleColor, userFill]);
  // Une URL conservée ne doit pas rouvrir un bot sorti du roster actif. La
  // suppression est un soft delete (donc la ligne reste dans le roster pour
  // Réglages → Archives) : il faut juger `archivedAt`, pas seulement l'absence
  // de la ligne. `replace` empêche Retour de rouvrir aussitôt la même URL.
  useEffect(() => {
    if (botUnavailable) void navigate({ to: "/", replace: true });
  }, [botUnavailable, navigate]);
  // Un bot, un fil : `bot.threadId` EST la conversation. `?task=` ne désigne
  // plus une session extra : elles n'existent plus : mais une branche de
  // variante de message, dont la tenancy est déjà vérifiée par la route de
  // fil : un id étranger y répond 404, il n'y a rien à valider ici.
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
  // Runtime remplacé : le profil nommé par le bot n'existe plus sur l'hôte.
  const profileStatus = useBotProfileStatus(bot, !linkClosed);
  const profileMissing = profileStatus.data?.state === "missing";
  const blockingError = roster.error ?? me.error ?? thread.error ??
    runtimes.error ?? runtimeModels.error ?? submissionError;
  const conversationBlocked = (Boolean(blockingError) && blockingError !== dismissedError) || runtimeUnavailable || retrying;
  const conversationErrorMessage = runtimeUnavailable && runtimeHealth === "disconnected"
    ? t("conversation.linkUnavailable")
    : blockingError instanceof ApiError &&
    blockingError.code === "RUNTIME_LINK_UNAVAILABLE"
    ? t("conversation.linkUnavailable")
    : userFacingError(blockingError, t("conversation.loadFailed"));
  // The runtime is down and nothing else is wrong: the thread stays readable,
  // the banner on the composer and the badge in the top bar say it, instead of
  // a blurred modal whose sentence then ended up truncated in the placeholder.
  // Any other blocking error keeps the modal.
  const linkLost = blockingError instanceof ApiError && blockingError.code === "RUNTIME_LINK_UNAVAILABLE";
  const runtimeOffline =
    (runtimeUnavailable &&
      (runtimeHealth === "disconnected" || runtimeHealth === "unreachable") &&
      (!blockingError || linkLost || blockingError === dismissedError)) ||
    (linkLost && blockingError !== dismissedError);
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

  // Bot mode : les bots joignables par `@slug` : tous ceux du roster sauf
  // celui du fil (le cloud API ignore de toute façon une mention de soi-même).
  // Mémoïsé : la timeline s'en sert pour ses chips et ses bulles sont `memo`.
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
    messages: thread.data && thread.data.id === activeThreadId ? thread.data.messages : [],
    events: thread.data && thread.data.id === activeThreadId ? thread.data.events : [],
    mentionables,
    operatorUsername: roster.data?.operator?.username ?? null,
  });

  // Un DM n'est pas mono-locuteur : une étape déléguée est exécutée par un
  // AUTRE bot du roster. Sans cette carte run -> auteur, sa bulle empruntait
  // le visage et le nom du bot du fil : la réponse de Neo signée Scout.
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
      // Le choix de modèle ou d'effort en cours d'enregistrement, fait ici ou
      // sur la page du bot : l'envoi l'attend (quelques millisecondes) au lieu
      // d'être bloqué, et part avec lui.
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
    // L'échec appartient au fil qui l'a produit : sans ce reset, l'alerte
    // « Le message n'est pas parti » suivait l'opérateur sur la conversation
    // suivante, où plus rien ne la justifiait.
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
  // Ces trois-là partent au fil (`memo`) : une identité neuve à chaque frappe
  // du composer suffirait à lui faire tout reconstruire. Ils lisent messages et
  // versions par ref : dépendre de `thread.data?.messages` changeait leur
  // identité à chaque 202 et vidait le cache par tour du fil (mesuré à 396 ms).
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
  // `bot` est une ligne du roster, recréée à chaque patch (202, flux) : lue par ref.
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
   * Les props du fil, stabilisées.
   *
   * `ThreadTimeline` est sous `memo` : un tableau ou une lambda recréés à
   * chaque rendu le feraient re-rendre à CHAQUE frappe du composer : c'est
   * exactement la latence de saisie qu'on cherchait. Un `?? []` littéral au
   * point d'appel suffit à casser la comparaison, d'où ces mémos.
   */
  const timelineEvents = useMemo(() => thread.data?.events ?? [], [thread.data?.events]);
  const timelineMessages = useMemo(() => thread.data?.messages ?? [], [thread.data?.messages]);
  // Only gates still awaiting a human on a live run: a stale `pending` row of a
  // concluded run must neither render a card nor hide the composer.
  const timelineApprovals = useMemo(
    () => liveApprovals(thread.data?.approvals ?? [], thread.data?.runs ?? []),
    [thread.data?.approvals, thread.data?.runs],
  );
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
  const secondaryReadsReady = useSecondaryReadsReady();
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
    () => !isMobile && secondaryReadsReady ? buildThreadRailTurns(timelineMessages, timelineUserInputs) : [],
    [isMobile, secondaryReadsReady, timelineMessages, timelineUserInputs],
  );
  // Même condition que le rail : le fil et l'activité partagent alors la gouttière de 3.5rem.
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
  // `queued` compte : entre l'envoi et la prise par le worker, le fil est déjà
  // occupé : sans lui, ni indicateur d'activité ni bouton stop pendant l'attente.
  const running =
    activeRun?.status === "running" ||
    activeRun?.status === "starting" ||
    activeRun?.status === "queued" ||
    activeRun?.status === "pending";
  usePublishRunInProgress(running);
  const cancel = useMutation({
    mutationFn: () => api.cancelRun(activeRun!.id),
    // Le snapshot peut avoir changé entre l'affichage du bouton et le POST
    // (Hermes a fini, ou un autre worker a déjà réconcilié). Relire le fil
    // dans les deux cas évite de laisser « le run continue » sur un état périmé.
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
    // Profil absent du runtime : l'encart de réparation dit déjà quoi faire.
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

  // Une gate en attente bloque le composer : laisser écrire pendant qu'une
  // décision est due donnerait l'illusion que le bot peut continuer sans elle.
  const pendingGate = timelineApprovals.length > 0;

  // Tant que la carte n'est pas lancée, un envoi est une correction de plan,
  // pas une exécution. Le worker décide les portes de ces tours comme en
  // Mode plan (`planOnly`) ; les lectures restent permises.
  useEffect(() => {
    if (!activeThreadId || !planTurn) return;
    // Quitter le plan sans effacer le tour le rouvre au prochain switch :
    // la carte repart sur l'ancien plan. L'exécution, elle, n'est plus une carte.
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
  // Donnée passée au fil, pas un callback conditionnel : voir le commentaire
  // sur `onEditMessage`/`onRegenerateMessage` plus bas.
  const canEditMessages = me.data?.session.canWrite === true && !running && !pendingGate &&
    !createVersion.isPending;

  // ask_user : la question qui TERMINE le dernier tour achevé. La sortie du
  // run est la source (pas la timeline) : dès que l'opérateur répond, le
  // dernier run devient sa réponse et le panneau tombe de lui-même.
  // La carte vit dans le fil (`AskUserCard`) : son rappel garde une identité
  // stable (contexte global du cache des tours) et lit l'envoi par ref.
  const sendRef = useRef(send);
  sendRef.current = send;
  const pickAskUser = useCallback((text: string) => {
    if (!sendRef.current.isPending) sendRef.current.mutate({ input: text, attachments: [] });
  }, []);
  // Le « x » de la carte ignore la question : elle se replie dans le fil.
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

  // Le laboratoire reste consultable même lorsque le fil travaille : le
  // bouton du header ouvre toujours la boîte, mais le CTA explique pourquoi
  // un second run ne peut pas encore partir.
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

  // « Planifier d'abord » : une intention de CE fil, envoyée avec chaque
  // message (`planOnly`). Un bot déjà en Mode plan (sa fiche) planifie
  // partout : l'intention n'y ajoute rien, et Lancer n'y exécuterait pas.
  const planMode = planFirst && bot.permissionMode !== "plan";
  // Profil en préparation : l'API refuse tout changement de modèle (409
  // BOT_PROFILE_PREPARING) et le message suivant partirait sur l'ancien. Le
  // sélecteur attend donc la fin de la préparation (le roster est relu toutes les 0,6 s).
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
  // Un tour de plan qui se termine sur une question (`@user ...` + options)
  // n'a pas de plan : la bulle et la carte de question prennent la place du
  // dock, et Lancer n'est pas proposé tant qu'aucun plan n'existe.
  const planQuestion = realPlanOpen && !planWriting &&
    (askUser !== null || parseAskUser(planSource, roster.data?.operator ?? null) !== null);
  const planDockOpen = planOpen && !planQuestion;
  // Masquer la bulle seulement quand la carte a déjà le texte. Avant ça, le
  // fil n'a plus ni bulle ni carte : un trou, puis le contenu qui réapparaît.
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
    // Le plan est une parenthèse du fil : Lancer la referme et l'exécution
    // part sans `planOnly`, sous le mode du bot. Le bot lui-même n'a jamais
    // changé de mode.
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
        /* Le titre porte un visage et un nom : il reste calé à gauche. */
        align="start"
        avatar={<BotFace name={bot.name} seed={bot.id} face={bot.face} className={isMobile ? "size-9" : "size-5"} />}
        title={<span className="truncate">{bot.name}</span>}
        /*
          Téléphone : la ligne sous le nom dit sur quel modèle le bot répond,
          comme le « en ligne » d'un contact. La jauge de contexte n'a qu'une
          seule place, la ligne de statut sous le composer (DESIGN.md) : la
          répéter ici faisait deux pastilles pour la même mesure.
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
            {/* L'état durable du travail en cours : un bouton, pas une bande
                épinglée au-dessus du fil (voir `WorkflowOverview`). */}
            {!threadLoading && thread.data ? (
              <WorkflowOverview
                threadId={thread.data.id}
                workflows={thread.data.workflows}
                runs={thread.data.runs}
              />
            ) : null}
            {/* Roue crantée : la config de CE bot, en modal à rubriques. */}
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
            {/* Laboratoire de scénarios, développement seulement, et au
                bureau seulement : sur téléphone la barre n'a que deux
                places, et un outil de dev n'en prend pas une. Le clic ouvre
                la boîte ; l'envoi réel passe ensuite par la MÊME mutation
                que le composer. */}
            {SHOW_FEATURE_LAB && !isMobile ? (
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
        }
      />
  );


  // Anneau de contexte du dernier tour mesuré (rien tant que le fil n'a pas
  // tourné) : dans l'en-tête au bureau, sous le composer au téléphone.
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

      {/* US-CHAT-08 : le fil et le canevas de lecture partagent la rangée : un
          fichier s'ouvre À CÔTÉ de la conversation qui en parle, jamais
          par-dessus, parce que c'est en la lisant qu'on veut le consulter. Le
          panneau ne prend de place que lorsqu'il est ouvert. Le composer reste
          DANS la colonne du fil : c'est à ce fil qu'on écrit, pas au fichier. */}
      {/* `relative` : au doigt, le canevas de pièce jointe se pose en
          `absolute inset-0` DANS cette rangée : donc dans la géométrie que la
          coque tient du `visualViewport`, sous l'en-tête et au-dessus du fil.
          Bureau : l'en-tête reste DANS la colonne du fil, comme le titre du
          guichet reste dans sa carte : sinon les actions (réglages, support)
          flottent au-dessus du fichier ouvert. */}
      <div className="relative flex min-h-0 flex-1">
        {/* `data-thread-column` : messages, docks et composer se centrent dans
            une colonne de lecture (`--openedbot-thread-column`, thread-timeline.css).
            La rangée reste pleine largeur : le défilement du fil garde sa
            barre au bord de la fenêtre, l'en-tête ses actions à droite. */}
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
                  {/* Un mode qui sort de l'ordinaire (Mode plan, Accès
                      complet) se voit ici, en lecture : il se change dans la
                      fiche du bot. Au téléphone, dans le sous-titre. */}
                  <PermissionModeBadge bot={bot} onOpen={openBotApprovals} />
                  {!threadLoading && thread.data ? (
                    <WorkflowOverview
                      threadId={thread.data.id}
                      workflows={thread.data.workflows}
                      runs={thread.data.runs}
                    />
                  ) : null}
                </>
              )}
              model={standalone ? null : (
                <>
                  <ThreadModelPicker
                    key={bot.id}
                    bot={bot}
                    variant="header"
                    servedBy={lastTurnFallback}
                    disabled={threadLoading || pendingGate || conversationBlocked || !!bot.profileImportStatus || profileMissing || provisioning}
                  />
                  {/* Bureau : l'anneau de contexte suit le modèle, dans l'en-tête. */}
                  {contextMeter}
                </>
              )}
              onOpenSettings={openBotManage}
              onOpenFeatureLab={SHOW_FEATURE_LAB ? () => setFeatureLabOpen(true) : undefined}
            /></DevRenderProfiler>
          )}
        <ConversationAvailability
          modal
          onDismiss={() => {
            setDismissedError(blockingError);
            setSubmissionError(null);
          }}
          blocked={conversationBlocked && !runtimeOffline}
          locked={profileMissing}
          message={conversationErrorMessage}
          retrying={retrying}
          onRetry={() => void retryConversation()}
        >
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
            // `beginEdit`/`regenerate` partent toujours, identité stable : les
            // envelopper dans un ternaire sur `running`/`pendingGate` flippait
            // la prop à chaque démarrage/fin de run, et vidait le cache par
            // tour du fil (`turnNodeCache`, thread-timeline.tsx) pour TOUT le
            // fil. La disponibilité part maintenant comme une DONNÉE
            // (`canEditMessages`), lue par tour, pas par la référence du
            // callback.
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
          {/* Profil en préparation : l'écran du centre le dit seul, sans fil
              ni composer (ThreadArrival, ComposerArrival) ; le dock se tait
              jusqu'à ce que le profil soit prêt. */}
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
            value={draft}
            onChange={(next) => {
              if (send.isError) send.reset();
              setDraft(next);
            }}
            onSubmit={() => {
              if (send.isPending || conversationBlocked) return;
              // Planifier d'abord : ce champ corrige le plan. Lancer est le
              // seul envoi qui autorise l'exécution ; d'ici là, le serveur
              // décide les portes du tour comme en Mode plan (0155).
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
            // Gate : on dit pourquoi. Un envoi en vol ne grise plus le champ
            // : le clavier iOS doit rester ouvert.
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
            // L'anneau de contexte du dernier tour mesuré (rien tant que le fil
            // n'a pas tourné). Le modèle reste dans l'en-tête.
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
