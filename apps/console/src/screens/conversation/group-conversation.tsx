import { ConversationDiagnostic } from "../../components/conversation-diagnostic";
import { ConversationFiles } from "../../components/conversation-files";
import { isRestoredQueryData } from "../../lib/query-persister";
import { useWorkspaceConversationDraft } from "../../lib/workspace/workspace-draft";
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
 * A group room (bot mode « Groups »): the counterpart of `ConversationScreen`
 * for a thread with no single bot. The thread's `botId` is `null`; it is `group` that
 * carries the displayed identity, and `runs[].botId` that says which member speaks on
 * THIS turn (see `runAuthors`, passed to `ThreadTimeline`).
 */
export function GroupConversationScreen() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const { groupId } = useParams({ from: "/_app/g/$groupId" });
  const queryClient = useQueryClient();
  const draftScope = `group:${groupId}`;
  const { draft, setDraft, attachments, setAttachments, unpersisted } = useWorkspaceConversationDraft(draftScope);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const clearReply = () => {
    setReplyToId(null);
    setReplyQuote(null);
  };

  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster });
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  // The MCP plugins connected to the runtime: typing their name colors the word
  // in the composer. Read reserved to `owner`/`admin` (see the hook).
  const mcpPlugins = useConnectedMcpPlugins(me.data?.session.role);
  const group = roster.data?.groups?.find((candidate) => candidate.id === groupId);
  const { thread, streaming, loading, loadOlder, loadingOlder, olderError, liveText } = useThreadStream(group?.threadId);
  useMarkThreadRead(
    group?.threadId,
    thread.data?.id === group?.threadId ? thread.data : null,
  );

  // Content-stable, like the direct thread: the 202, the
  // read receipt and every SSE flush patch the roster; a new array or Map
  // with the same content would re-run the thread model and every turn
  // signature for nothing.
  const mentionables = useContentStable(useMemo(
    () => (group?.members ?? []).filter((member) => !member.archivedAt),
    [group?.members],
  ), sameAuthorList);
  const threadFind = useThreadFind({
    runs: thread.data?.runs,
    messages: thread.data && thread.data.id === group?.threadId ? thread.data.messages : [],
    events: thread.data && thread.data.id === group?.threadId ? thread.data.events : [],
    mentionables,
    operatorUsername: roster.data?.operator?.username ?? null,
  });

  // Groups: the member whose turn it is, by `runId`: that run's assistant
  // bubble carries their face and their name (see `ThreadTimeline`).
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
    // The failure belongs to the room that produced it, not to the next one.
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
  // Messages read by ref: depending on `thread.data?.messages` changed
  // the callback's identity on every send and emptied the thread's per-turn cache.
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

  // Between two turns of the room, no run is active for a moment: `running`
  // therefore follows the roster indicator (which covers the whole series of
  // turns), or the run actually active/waiting in the thread.
  // A snapshot or roster read back from IndexedDB is never live run state
  // (`lib/query-persister.ts`): it paints the room, the fresh reads say who runs.
  const activeRun = isRestoredQueryData(thread.data) ? undefined : currentThreadRun(thread.data?.runs ?? []);
  // `queued` counts: a queued room turn already occupies the room.
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

  // A room turn that fails deserves more than a chip in the thread: a toast,
  // ONCE per run: the same "failed" comes back on every refetch.
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

  // ask_user: a member's escalation (`@elodie … + options`) that closes the
  // LAST turn of the room. The run's output is the source; a `pass` is
  // never parsed. The panel addresses the room: the reply is an ordinary
  // operator message, which opens a send again.
  // The card lives in the thread (`AskUserCard`): a stable-identity callback.
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

  const timelineEvents = useMemo(() => thread.data?.events ?? [], [thread.data?.events]);
  const routineRunKey = (thread.data?.runs ?? []).filter((run) => run.routineId).map((run) => run.id).join(",");
  const timelineMessages = useMemo(() => {
    const messages = thread.data?.messages ?? [];
    if (!routineRunKey) return messages;
    const routineRuns = new Set(routineRunKey.split(","));
    return messages.filter((message) => message.role !== "user" || !message.runId || !routineRuns.has(message.runId));
  }, [thread.data?.messages, routineRunKey]);
  const timelineSettingProposals = useMemo(() => thread.data?.settingProposals ?? [], [thread.data?.settingProposals]);
  const timelineRuns = useMemo(() => thread.data?.runs ?? [], [thread.data?.runs]);
  const timelineUserInputs = useMemo(
    () =>
      timelineMessages
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
    [timelineMessages],
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

  // A crew has not one gauge but one per member: the pill shows the most
  // loaded, the dialog lists them. Nothing while the thread has no run.
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
        /* The title carries a face and a name: it stays pinned to the left. */
        align="start"
        /* Phone: the pill under the name, like a contact's « en ligne »
           (same place as a single bot's). */
        subtitle={isMobile && thread.data?.runs.length ? (
          <div data-thread-subtitle="" className="flex min-w-0 items-center gap-1.5 text-[13px] leading-4 text-muted-foreground">
            {contextTab("inline")}
          </div>
        ) : undefined}
        title={
          <>
            {/* The stack has an intrinsic width greater than a single
                face. Never apply `size-5` to it: that constrains its
                container to 20 px and makes the name start under the last
                two faces. */}
            <GroupFaceStack members={group.members} size="size-5" />
            <span className="min-w-0 truncate font-semibold">{group.name}</span>
          </>
        }
        actions={
          <>
            {/* The room's durable state: a button in the header, not a
                band pinned above the thread (see `WorkflowOverview`). */}
            {!threadLoading && thread.data ? (
              <>
                <ConversationFiles key={thread.data.id} threadId={thread.data.id} />
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

      {/* US-CHAT-08: the thread and the reading canvas share the row: a
          file opens BESIDE the conversation that talks about it, never
          on top of it, because one wants to consult it while reading that conversation. The
          panel takes space only when it is open. The composer stays
          IN the thread column: one writes to that thread, not to the file. */}
      {/* `relative`: on touch, the attachment canvas sits in
          `absolute inset-0` INSIDE this row: so in the geometry the
          shell takes from `visualViewport`, under the header and above the thread.
          Desktop: the header stays IN the thread column, as the desk title
          stays in its card. */}
      <div className="relative flex min-h-0 flex-1">
        {/* `data-thread-column`: the same reading column as a bot's thread
            (`--openedbot-thread-column`, thread-timeline.css). Without it, the room's messages,
            docks and composer stretched across the whole window. */}
        <div data-thread-column="" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {isMobile ? null : header}
          {activeRun?.status === "failed" ? <ConversationDiagnostic code={activeRun.errorCode} reference={activeRun.id} onRetry={()=>void thread.refetch()} retrying={thread.isFetching} /> : null}
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
            <DevRenderProfiler id="thread-timeline"><ThreadTimeline liveText={liveText}
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
            attachmentScope={draftScope}
            draftUnpersisted={unpersisted}
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
            // A gate blocks writing. An in-flight send must NOT grey
            // the field: the iOS keyboard would stay closed (ChatGPT keeps it).
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
