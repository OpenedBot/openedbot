import { isRestoredQueryData } from "../../lib/query-persister";
import { useWorkspaceTextDraft, useWorkspaceAttachmentDraft } from "../../lib/workspace/workspace-draft";
import { usePublishRunInProgress } from "../../lib/run/run-in-progress";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast, useIsMobile } from "@openedbot/browser-ui-kit";
import type { MessageAuthorBot } from "@openedbot/contracts-api";
import { replyPreviewSnippet, replyQuoteText, type MessageReactionEmoji } from "@openedbot/conversation/domain/message-reply";
import { ApiError, api, queryKeys, userFacingError } from "../../lib/api";
import { applySendAcceptedToCaches } from "../../lib/thread/apply-send-accepted";
import { useThreadMessageSend } from "../../lib/thread/use-thread-message-send";
import {
  threadContainsOutgoingUserInput,
} from "../../lib/thread/thread-anchor";
import { useThreadStream } from "../../lib/stream/use-thread-stream";
import { useConnectedMcpPlugins } from "../../lib/runtime/use-mcp-plugins";
import { Composer } from "../../components/composer";
import { GroupFaceStack } from "../../components/group-face-stack";
import { ThreadTimeline } from "../../components/thread-timeline";
import { ThreadTurnRail } from "../../components/thread-turn-rail";
import { buildThreadRailTurns } from "../../lib/thread/thread-turn-rail";
import { WorkflowOverview } from "../../components/workflow-overview";
import { GroupContextTab } from "../../components/group-context-tab";
import { AttachmentCanvas, AttachmentCanvasProvider } from "../../components/attachment-canvas";
import { SiteHeader } from "../../components/dashboard/site-header";
import { ConversationPending, ThreadSkeleton } from "../../components/thread-skeleton";
import { parseAskUser } from "@openedbot/roster/domain/ask-user";
import { useDismissedAskUserRuns } from "../../lib/run/ask-user-dismissals";
import { useT } from "../../lib/i18n";
import { readableRunFailure } from "../../lib/run/model-unavailable";
import { runProviderAuthLabel } from "../../lib/runtime/provider-auth";
import { currentThreadRun } from "../../lib/thread/current-thread-run";
import { useMarkThreadRead } from "../../lib/thread/use-mark-thread-read";
import { useThreadFind } from "../../lib/thread/use-thread-find";
import { PendingApprovalDock } from "../../components/gate-card";
import { liveApprovals } from "../../lib/run/live-approvals";
import { RunActivityDock } from "../../components/run-activity-dock";
import { DevRenderProfiler } from "../../components/dev/dev-render-profiler";
import { sameAuthorList, sameAuthorMap, sameValueMap, useContentStable } from "../../lib/hooks/use-content-stable";
import { BUTTON } from "../../components/settings/primitives";

/**
 * Un salon de groupe (bot mode « Groups ») : le pendant de `ConversationScreen`
 * pour un fil sans bot unique. `botId` du fil est `null` ; c'est `group` qui
 * porte l'identité affichée, et `runs[].botId` qui dit quel membre parle sur
 * CE tour (voir `runAuthors`, transmis à `ThreadTimeline`).
 */
export function GroupConversationScreen() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const { groupId } = useParams({ from: "/_app/g/$groupId" });
  const queryClient = useQueryClient();
  const draftScope = `group:${groupId}`;
  const [draft, setDraft] = useWorkspaceTextDraft(draftScope);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const clearReply = () => {
    setReplyToId(null);
    setReplyQuote(null);
  };
  /** Les pièces jointes du brouillon (US-CHAT-08) : tenues par l'écran, comme le texte. */
  const [attachments, setAttachments] = useWorkspaceAttachmentDraft(draftScope);

  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster });
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  // Les plugins MCP branchés sur le runtime : écrire leur nom colore le mot
  // dans le composer. Lecture réservée aux `owner`/`admin` (voir le hook).
  const mcpPlugins = useConnectedMcpPlugins(me.data?.session.role);
  const group = roster.data?.groups?.find((candidate) => candidate.id === groupId);
  const { thread, streaming, loading, loadOlder, loadingOlder, olderError } = useThreadStream(group?.threadId);
  useMarkThreadRead(
    group?.threadId,
    thread.data?.id === group?.threadId ? thread.data : null,
  );

  // Content-stable, like the direct thread (OHB-135, OHB-141): the 202, the
  // read receipt and every SSE flush patch the roster; a new array or Map
  // with the same content would re-run the thread model and every turn
  // signature for nothing.
  const mentionables = useContentStable(useMemo(
    () => (group?.members ?? []).filter((member) => !member.archivedAt),
    [group?.members],
  ), sameAuthorList);
  const threadFind = useThreadFind({
    messages: thread.data && thread.data.id === group?.threadId ? thread.data.messages : [],
    events: thread.data && thread.data.id === group?.threadId ? thread.data.events : [],
    mentionables,
    operatorUsername: roster.data?.operator?.username ?? null,
  });

  // Groupes : le membre dont c'est le tour, par `runId` : la bulle assistant
  // de ce run porte son visage et son nom (voir `ThreadTimeline`).
  const runAuthors = useContentStable(useMemo(() => {
    const map = new Map<string, MessageAuthorBot>();
    for (const run of thread.data?.runs ?? []) {
      if (!run.botId) continue;
      const member = group?.members.find((candidate) => candidate.id === run.botId);
      if (member) map.set(run.id, { id: member.id, name: member.name, slug: member.slug, face: member.face });
    }
    return map;
  }, [thread.data?.runs, group?.members]), sameAuthorMap);
  const speechVoiceByBotId = useContentStable(useMemo(
    () => new Map((group?.members ?? []).map((member) => [member.id, member.voiceId] as const)),
    [group?.members],
  ), sameValueMap);

  const send = useThreadMessageSend({
    threadId: group?.threadId,
    draft: { input: draft, attachments, replyToId },
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
      toast.error(userFacingError(error, t("threadScreen.sendFailed")));
    },
  });
  const outgoingUser = send.outgoing;
  // `send.retry` changes identity with `isPending`: passed as is, it re-rendered
  // the memoized thread on the send tick and again on the 202 tick.
  const sendRetryRef = useRef(send.retry);
  sendRetryRef.current = send.retry;
  const retryOutgoing = useCallback(() => sendRetryRef.current(), []);

  useEffect(() => {
    clearReply();
    // L'échec appartient au salon qui l'a produit, pas au suivant.
    send.reset();
  }, [group?.threadId]);

  const reaction = useMutation({
    mutationFn: ({ messageId, emoji, active }: {
      messageId: string;
      emoji: MessageReactionEmoji;
      active: boolean;
    }) => active
      ? api.removeMessageReaction(group!.threadId, messageId, emoji)
      : api.addMessageReaction(group!.threadId, messageId, emoji),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(group!.threadId) });
    },
  });

  const replyMessage = thread.data?.messages.find((message) => message.id === replyToId) ?? null;
  const replyAuthor = replyMessage
    ? replyMessage.authorBot?.name ?? replyMessage.authorBot?.slug ??
      (replyMessage.role === "assistant" ? t("threadTimeline.assistant") : t("threadTimeline.operator"))
    : null;
  const replyPreview = replyMessage && replyAuthor
    ? {
        author: replyAuthor,
        text: replyPreviewSnippet(replyQuote ?? replyQuoteText(replyMessage.content)),
      }
    : null;
  // Messages lus par ref : dépendre de `thread.data?.messages` changeait
  // l'identité du callback à chaque envoi et vidait le cache par tour du fil.
  const threadMessagesRef = useRef(thread.data?.messages);
  threadMessagesRef.current = thread.data?.messages;
  const selectReply = useCallback((messageId: string, quote?: string) => {
    if (!threadMessagesRef.current?.some((message) => message.id === messageId)) return;
    setReplyToId(messageId);
    setReplyQuote(quote?.trim() || null);
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")?.focus();
    });
  }, []);
  const onReaction = useCallback(
    (messageId: string, emoji: MessageReactionEmoji, active: boolean) =>
      reaction.mutateAsync({ messageId, emoji, active }),
    [reaction.mutateAsync],
  );

  const stopRoom = useMutation({
    mutationFn: () => api.stopRoom(group!.threadId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(group!.threadId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
    },
  });

  // Entre deux tours du salon, aucun run n'est actif un instant : `running`
  // suit donc l'indicateur du roster (qui, lui, couvre toute la série de
  // tours), ou le run effectivement actif/attendant dans le fil.
  // A snapshot or roster read back from IndexedDB is never live run state
  // (`lib/query-persister.ts`): it paints the room, the fresh reads say who runs.
  const activeRun = isRestoredQueryData(thread.data) ? undefined : currentThreadRun(thread.data?.runs ?? []);
  // `queued` compte : un tour de salon en file occupe déjà la pièce.
  const runActive =
    activeRun?.status === "running" ||
    activeRun?.status === "starting" ||
    activeRun?.status === "queued" ||
    activeRun?.status === "pending";
  const running = (!isRestoredQueryData(roster.data) && Boolean(group?.running)) || runActive;
  usePublishRunInProgress(running);

  // Only gates still awaiting a human on a live run: a stale `pending` row of a
  // concluded run must neither render a card nor hide the composer.
  const timelineApprovals = useMemo(
    () => liveApprovals(thread.data?.approvals ?? [], thread.data?.runs ?? []),
    [thread.data?.approvals, thread.data?.runs],
  );
  const pendingGate = timelineApprovals.length > 0;
  const pendingApprovalRequest = timelineApprovals.find((approval) => approval.status === "pending") ?? null;
  const approvalRequester = pendingApprovalRequest
    ? group?.members.find((member) => member.id === pendingApprovalRequest.botId)?.name
    : undefined;
  const threadLoading = loading || thread.data?.id !== group?.threadId;
  const threadFailed = thread.isError && thread.data?.id !== group?.threadId;
  const threadFailureMessage = thread.error instanceof ApiError &&
    thread.error.code === "DATABASE_MIGRATION_REQUIRED"
    ? t("conversation.migrationRequired")
    : t("conversation.loadFailed");

  // Un tour de salon qui échoue mérite plus qu'un chip dans le fil : un toast,
  // UNE fois par run : le même « failed » revient à chaque refetch.
  const notifiedFailedRunId = useRef<string | null>(null);
  // Read when the failure fires, never a dependency (see conversation.tsx).
  const failureEventsRef = useRef(thread.data?.events);
  failureEventsRef.current = thread.data?.events;
  useEffect(() => {
    if (activeRun?.status !== "failed" || activeRun.id === notifiedFailedRunId.current) return;
    notifiedFailedRunId.current = activeRun.id;
    const member = group?.members.find((candidate) => candidate.id === activeRun.botId);
    toast.error(
      readableRunFailure(t, activeRun, member?.name ?? t("threadTimeline.unknownBot"), runProviderAuthLabel(failureEventsRef.current, activeRun.id))
        ?? activeRun.error
        ?? t("threadTimeline.runtimeErrorFallback"),
    );
  }, [activeRun?.id, activeRun?.status, activeRun?.error, activeRun?.errorCode, t]);

  // ask_user : l'escalade d'un membre (`@elodie … + options`) qui clôt le
  // DERNIER tour du salon. La sortie du run est la source ; un `pass` ne
  // parse jamais. Le panneau s'adresse à la pièce : la réponse est un message
  // opérateur ordinaire, qui rouvre un envoi.
  // La carte vit dans le fil (`AskUserCard`) : rappel d'identité stable.
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

  const timelineEvents = useMemo(() => thread.data?.events ?? [], [thread.data?.events]);
  const timelineMessages = useMemo(() => thread.data?.messages ?? [], [thread.data?.messages]);
  const timelineSettingProposals = useMemo(() => thread.data?.settingProposals ?? [], [thread.data?.settingProposals]);
  const timelineRuns = useMemo(() => thread.data?.runs ?? [], [thread.data?.runs]);
  const timelineUserInputs = useMemo(
    () =>
      (thread.data?.messages ?? [])
        .filter((message) => message.role === "user")
        .map((message) => ({
          id: message.id,
          clientSubmissionId: message.clientSubmissionId,
          runId: message.runId,
          authorBot: message.authorBot ?? null,
          createdAt: message.createdAt,
          text: message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join(""),
          attachments: message.content.filter((part) => part.type === "attachment"),
        })),
    [thread.data?.messages],
  );
  const railTurns = useMemo(() => buildThreadRailTurns(timelineMessages), [timelineMessages]);
  const turnRailShown = !isMobile && railTurns.length >= 2;
  const timelineOutgoing = outgoingUser &&
    !threadContainsOutgoingUserInput(timelineUserInputs, outgoingUser)
    ? outgoingUser
    : null;
  useEffect(() => {
    if (outgoingUser && !timelineOutgoing) send.clearOutgoing();
  }, [outgoingUser, timelineOutgoing]);

  if (!group) {
    if (roster.isPending) return <ConversationPending />;
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t("groups.groupGone")}
      </div>
    );
  }

  // Un crew n'a pas une jauge mais une par membre : la pastille montre le plus
  // chargé, le dialogue les liste. Rien tant que le fil n'a aucun run.
  const contextTab = (variant: "header" | "inline") =>
    thread.data?.runs.length ? (
      <GroupContextTab
        variant={variant}
        members={group.members}
        bots={roster.data?.bots ?? []}
        runs={thread.data.runs}
        events={thread.data.events}
        threadId={thread.data.id}
        messages={thread.data.messages}
        compaction={thread.data.compaction ?? null}
      />
    ) : null;

  const header = (
    <DevRenderProfiler id="conversation-header">
      <SiteHeader
        /* Le titre porte un visage et un nom : il reste calé à gauche. */
        align="start"
        /* Téléphone : la pastille sous le nom, comme le « en ligne » d'un
           contact (même place que celle d'un bot seul). */
        subtitle={isMobile && thread.data?.runs.length ? (
          <div data-thread-subtitle="" className="flex min-w-0 items-center gap-1.5 text-[13px] leading-4 text-muted-foreground">
            {contextTab("inline")}
          </div>
        ) : undefined}
        title={
          <>
            {/* La pile a une largeur intrinsèque supérieure à un seul
                visage. Ne jamais lui appliquer `size-5` : cela contraint son
                conteneur à 20 px et fait commencer le nom sous les deux
                derniers visages. */}
            <GroupFaceStack members={group.members} size="size-5" />
            <span className="min-w-0 truncate font-semibold">{group.name}</span>
          </>
        }
        actions={
          <>
            {/* L'état durable du salon : un bouton dans l'en-tête, pas une
                bande épinglée au-dessus du fil (voir `WorkflowOverview`). */}
            {!threadLoading && thread.data ? (
              <>
                <WorkflowOverview
                  threadId={thread.data.id}
                  workflows={thread.data.workflows}
                  runs={thread.data.runs}
                />
                {isMobile ? null : contextTab("header")}
              </>
            ) : null}
          </>
        }
      />
    </DevRenderProfiler>
  );

  return (
    <AttachmentCanvasProvider>
      {isMobile ? header : null}

      {/* US-CHAT-08 : le fil et le canevas de lecture partagent la rangée : un
          fichier s'ouvre À CÔTÉ de la conversation qui en parle, jamais
          par-dessus, parce que c'est en la lisant qu'on veut le consulter. Le
          panneau ne prend de place que lorsqu'il est ouvert. Le composer reste
          DANS la colonne du fil : c'est à ce fil qu'on écrit, pas au fichier. */}
      {/* `relative` : au doigt, le canevas de pièce jointe se pose en
          `absolute inset-0` DANS cette rangée : donc dans la géométrie que la
          coque tient du `visualViewport`, sous l'en-tête et au-dessus du fil.
          Bureau : l'en-tête reste DANS la colonne du fil, comme le titre du
          guichet reste dans sa carte. */}
      <div className="relative flex min-h-0 flex-1">
        {/* `data-thread-column` : même colonne de lecture que le fil d'un bot
            (`--ohb-thread-column`, thread-timeline.css). Sans elle, messages,
            docks et composer du salon s'étiraient sur toute la fenêtre. */}
        <div data-thread-column="" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {isMobile ? null : header}
          {group.needsYou ? (
            <p data-thread-lane="" className="w-full shrink-0 px-4 sm:px-6 pt-2 text-xs text-muted-foreground">
              {t("groups.needsYou")}
            </p>
          ) : null}
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
          ) : threadLoading ? (
            <ThreadSkeleton />
          ) : (
            <div
              className="relative flex min-h-0 flex-1 flex-col"
              data-turn-rail={turnRailShown ? "" : undefined}
            >
            <DevRenderProfiler id="thread-timeline"><ThreadTimeline
              events={timelineEvents}
              runs={timelineRuns}
              messages={timelineMessages}
              userInputs={timelineUserInputs}
              outgoing={timelineOutgoing}
              onRetryOutgoing={retryOutgoing}
              mentionables={mentionables}
              runAuthors={runAuthors}
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
              onReaction={onReaction}
              speechScope={group.id}
              speechVoiceByBotId={speechVoiceByBotId}
              resnap={askUser !== null}
              scrollToBottomOnThreadKey={group.threadId ?? null}
            /></DevRenderProfiler>
            {isMobile ? null : <ThreadTurnRail turns={railTurns} />}
            </div>
          )}

          {stopRoom.isError ? (
            <p
              role="alert"
              data-thread-lane=""
              className="w-full shrink-0 px-4 sm:px-6 text-sm text-destructive-text"
            >
              {t("threadScreen.stopFailed")}
            </p>
          ) : null}

          <PendingApprovalDock
            approvals={timelineApprovals}
            requester={approvalRequester}
          />

          <DevRenderProfiler id="run-activity-dock">
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
          </DevRenderProfiler>

          <DevRenderProfiler id="composer"><Composer
            value={draft}
            onChange={(next) => {
              if (send.isError) send.reset();
              setDraft(next);
            }}
            onSubmit={() => {
              if (send.isPending) return;
              send.mutate({ input: draft.trim(), attachments, replyToId });
            }}
            onCancel={() => stopRoom.mutate()}
            escapeStopsRun={false}
            botName={group.name}
            disabled={threadLoading || pendingGate}
            // Une gate bloque l'écriture. Un envoi en vol ne doit PAS griser
            // le champ : le clavier iOS resterait fermé (ChatGPT le garde).
            disabledReason={pendingGate ? t("conversation.pendingDecision") : undefined}
            running={running}
            sending={send.isPending}
            mentionables={mentionables}
            mcpPlugins={mcpPlugins}
            showPlugins={false}
            attachments={attachments}
            onAttachmentsChange={(next) => {
              if (send.isError) send.reset();
              setAttachments(next);
            }}
            replyPreview={replyPreview}
            onCancelReply={clearReply}
          /></DevRenderProfiler>
        </div>
        <AttachmentCanvas />
      </div>
    </AttachmentCanvasProvider>
  );
}
