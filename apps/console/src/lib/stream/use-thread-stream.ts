import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { notifyManager, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  applyProductEventToSnapshot,
  isTerminalProductEvent,
} from "@openedbot/conversation/domain/thread-snapshot-mutations";
import type { RosterDto } from "@openedbot/contracts-api";
import { cursorForOpenThread, streamStartCursor } from "@/lib/stream/thread-stream-cursor";
import { refetchOnStreamOpen, refreshAfterAppliedEvent } from "@/lib/stream/thread-stream-live";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { OrganizationEvent, StreamGap } from "@openedbot/browser-api-client";
import { activeOrganizationId, cloudSessionRevision, subscribeCloudSession } from "../session/cloud-session";
import { api, queryKeys, type ThreadView } from "../api";
import {
  openThreadId,
  organizationStreamPosition,
  setOpenThread,
  shellProjectionActive,
  subscribeToOrganizationEvents,
} from "./organization-stream";
import {
  invalidateOrganizationProjection,
  organizationProjection,
  projectOrganizationEvent,
  writeOrganizationProjection,
} from "./organization-projection";
import { cancelStreamFlush, scheduleStreamFlush } from "./stream-frame";
import { createLiveRunText, createLiveTextHold, type LiveRunText, type ThreadLiveText } from "./live-run-text";
import { asLocalPatch, scheduleInvalidate } from "../query-client";
import { isRestoredQueryData } from "../query-persister";
import { mergeThreadHistory, readThreadHistoryHead } from "../thread/thread-history";
import { nextReviewWatch, REVIEW_POLL_MS, type ReviewWatch } from "../thread/thread-review-poll";
export { organizationStreamPosition, stopOrganizationStream, subscribeToOrganizationEvents } from "./organization-stream";
import {
  isCurrentThreadSnapshot,
  readNewestThreadSnapshot,
  shouldWaitForThreadSnapshot,
} from "./thread-stream-safety";

/**
 * The newest page of a thread, merged into what the cache already holds. One
 * definition for the screen and for the route loader that starts it before
 * the screen renders (`lib/thread/conversation-prefetch.ts`): same key, same read.
 */
export function threadQueryOptions(queryClient: QueryClient, threadId: string) {
  const queryKey = queryKeys.thread(threadId);
  // A snapshot restored from IndexedDB is replaced, never merged: turns
  // written since it was saved would leave a hole between its pages and the
  // fresh head (`lib/query-persister.ts`).
  const current = () => {
    const cached = queryClient.getQueryData<ThreadView>(queryKey);
    return isRestoredQueryData(cached) ? undefined : cached;
  };
  return {
    queryKey,
    queryFn: async (): Promise<ThreadView> => {
      const newest = await readNewestThreadSnapshot(
        () => readThreadHistoryHead((before) => api.thread(threadId, before), current()),
        current,
      );
      return mergeThreadHistory(current(), newest, "latest");
    },
  };
}

export function useThreadStream(threadId: string | undefined) {
  const queryClient = useQueryClient();
  const sessionRevision = useSyncExternalStore(subscribeCloudSession, cloudSessionRevision, cloudSessionRevision);
  const [streaming, setStreaming] = useState(false);
  const [switching, setSwitching] = useState(false);
  const cursorRef = useRef(0);
  const openThreadIdRef = useRef<string | undefined>(undefined);
  const olderRequest = useRef<{ threadId: string; promise: Promise<boolean> } | null>(null);
  const [olderState, setOlderState] = useState<{ threadId?: string; loading: boolean; error: boolean }>({ loading: false, error: false });
  // A gate under automatic review shows no card: poll until it settles (PERM2-7).
  const reviewWatch = useRef<ReviewWatch | null>(null);
  const [liveText] = useState<LiveRunText>(createLiveRunText); // answers in progress, outside the cache (`live-run-text.ts`)

  const thread = useQuery({
    ...(threadId
      ? threadQueryOptions(queryClient, threadId)
      : { queryKey: ["organization", activeOrganizationId() ?? "anonymous", "thread", "none"], queryFn: () => Promise.reject(new Error("no thread")) }),
    enabled: Boolean(threadId),
    refetchInterval: (query) => {
      const watch = nextReviewWatch(reviewWatch.current, query.state.data, Date.now());
      reviewWatch.current = watch.next;
      if (watch.poll) return REVIEW_POLL_MS;
      return streaming ? false : 5_000;
    },
  });

  const liveView = useMemo<ThreadLiveText>(() => ({ store: liveText, events: thread.data?.events ?? [] }), [liveText, thread.data?.events]);
  const loadOlder = useCallback((beforeMerge?: () => void): Promise<boolean> => {
    const pendingRequest = olderRequest.current;
    if (pendingRequest && pendingRequest.threadId === threadId) return pendingRequest.promise;
    if (!threadId) return Promise.resolve(false);
    const key = queryKeys.thread(threadId);
    const before = queryClient.getQueryData<ThreadView>(key)?.history?.nextBefore;
    if (!before) return Promise.resolve(false);
    setOlderState({ threadId, loading: true, error: false });
    const pending = { threadId, promise: Promise.resolve(false) };
    olderRequest.current = pending;
    const request = (async () => {
      try {
        const page = await api.thread(threadId, before);
        if (cloudSessionRevision() !== sessionRevision || openThreadIdRef.current !== threadId) return false;
        const current = queryClient.getQueryData<ThreadView>(key);
        if (!current || current.id !== page.id || current.history?.nextBefore !== before) return false;
        beforeMerge?.();
        queryClient.setQueryData<ThreadView>(key, mergeThreadHistory(current, page, "older"));
        setOlderState({ threadId, loading: false, error: false });
        return true;
      } catch {
        setOlderState({ threadId, loading: false, error: true });
        return false;
      } finally {
        if (olderRequest.current === pending) olderRequest.current = null;
        setOlderState((state) => state.threadId === threadId && state.loading ? { ...state, loading: false } : state);
      }
    })();
    pending.promise = request;
    return request;
  }, [threadId, queryClient, sessionRevision]);

  // The stream subscribes only once the thread snapshot is in the cache: it is
  // what gives the start cursor. Starting from zero made the server replay
  // the whole retained history of the organization: and every replayed
  // event cost a reread of the roster. This boolean flips only on
  // the arrival of the thread's first snapshot (or on its change), not on every
  // refresh: the subscription is not replayed for nothing.
  // A snapshot restored from IndexedDB paints the thread but does not start
  // the stream: its cursor may be hours old. The refetch that follows it does.
  const isLiveSnapshot = (snapshot: ThreadView | undefined): boolean =>
    threadId !== undefined && isCurrentThreadSnapshot(snapshot, threadId) && !isRestoredQueryData(snapshot);
  const snapshotReady = isLiveSnapshot(thread.data)
    || isLiveSnapshot(threadId === undefined ? undefined : queryClient.getQueryData<ThreadView>(queryKeys.thread(threadId)));

  // The shell's roster patch must not mark the thread on screen unread.
  useEffect(() => {
    setOpenThread(threadId);
    return () => { if (openThreadId() === threadId) setOpenThread(undefined); };
  }, [threadId]);

  useEffect(() => {
    if (!threadId) {
      openThreadIdRef.current = undefined;
      cursorRef.current = 0;
      setStreaming(false);
      setSwitching(false);
      return;
    }
    const cached = queryClient.getQueryData<ThreadView>(queryKeys.thread(threadId));
    // `cursorRef` stays the THREAD's cursor (the catch-up check below
    // compares `snapshot.cursor` to it); the stream, for its part, attaches to the
    // ORGANIZATION cursor carried by the snapshot: nothing to replay by construction.
    const previousThreadId = openThreadIdRef.current;
    cursorRef.current = cursorForOpenThread({
      openThreadId: previousThreadId,
      nextThreadId: threadId,
      currentCursor: cursorRef.current,
      snapshotCursor: cached?.cursor,
    });
    const initialStreamCursor = cursorForOpenThread({
      openThreadId: previousThreadId,
      nextThreadId: threadId,
      currentCursor: cursorRef.current,
      snapshotCursor: streamStartCursor(cached),
    });
    openThreadIdRef.current = threadId;
    // A session refresh restarts this effect even when the open thread did not
    // change. Setting `switching` to true unconditionally could then freeze the
    // screen forever: React Query legitimately keeps the same cache object, so
    // the snapshot effect below has no changed dependency with which to clear
    // the flag. Only an actually absent/wrong-thread snapshot is a switch.
    setSwitching(shouldWaitForThreadSnapshot(cached, threadId));
    if (!snapshotReady || !isCurrentThreadSnapshot(cached, threadId)) {
      // No snapshot yet for THIS thread: wait for it to arrive (the effect
      // replays when `snapshotReady` flips). `streaming` falls back so that
      // the thread's periodic reread resumes if the stream never starts again.
      setStreaming(false);
      return;
    }
    let disposed = false;
    let stop = () => {};
    const start = async () => {
      // A valid cookie can outlive the small local session mirror (cleared
      // storage, HMR, another tab). Re-read `/auth/me` once so the SSE client
      // has the organization it must put in `X-OpenedBot-Organization`.
      if (!activeOrganizationId()) {
        try {
          await api.authMe();
        } catch {
          if (!disposed) setStreaming(false);
          return;
        }
      }
      if (disposed) return;
      // Reconnect (Bun idleTimeout, at most 255 s, network, redeploy):
      // resume at `streamCursor`. No GET while the cursor is inside
      // the replay window. The gap (`stream.gap`, including outside the window
      // after a restart) rereads thread, roster and mail. Measurement of 24-08:
      // without this gap, a run that finished during a restart left « Réfléchit… ».
      // Exception: a stream already running, further ahead than this snapshot, may have
      // consumed events of this thread before this subscription.
      const position = organizationStreamPosition();
      let mayHaveMissed = position.running && position.cursor > initialStreamCursor;
      const onStatus = (connected: boolean) => {
        if (connected) {
          const refresh = refetchOnStreamOpen(mayHaveMissed);
          if (refresh.thread) scheduleInvalidate(queryKeys.thread(threadId));
          if (refresh.roster) scheduleInvalidate(queryKeys.roster);
          mayHaveMissed = false;
        }
        setStreaming(connected);
      };
      // The server raised the stream cursor (replay window exceeded):
      // what it will not return is reread: thread, roster, mail. Unless the
      // gap stops before our own attach point: that is then another
      // subscriber (notifications, an old persisted cursor) that opened
      // the stream lower than us, and nothing is missing for this screen.
      const onGap = (gap: StreamGap) => {
        if (gap.to <= initialStreamCursor) return;
        scheduleInvalidate(queryKeys.thread(threadId));
        scheduleInvalidate(queryKeys.roster);
        scheduleInvalidate(queryKeys.inbox);
      };
      // A running run can emit dozens of events per second (text delta, tool
      // calls…): they are queued here and the queue is reduced to ONE thread
      // patch per frame (`flushBuffered`, `stream-frame.ts`), without
      // changing the order or the reread decisions below.
      let buffered: OrganizationEvent[] = [];
      // Events this thread projects onto the roster, inbox and memories:
      // those delivered while the shell does not (`shellProjectionActive`).
      const projectHere = new WeakSet<OrganizationEvent>();
      const owner = {};
      // Events of a workspace left meanwhile never reach the new one's cache.
      const scope = JSON.stringify(queryKeys.roster);
      // The fragments of a confirmed answer wait here; only its bubble reads them (`liveText`).
      const hold = createLiveTextHold(() => performance.now());
      let holdTimer: ReturnType<typeof setTimeout> | null = null;
      // Runs of this thread that called the settings-proposal tool: the
      // proposal is written on the server side, the `run.completed` patch does not
      // carry it, so their end rereads the thread (once per run).
      const proposalRuns = new Set<string>();
      const flushBuffered = (releaseHeld = false) => {
        cancelStreamFlush(owner);
        if (buffered.length === 0 && (!releaseHeld || hold.dueIn(0) === null)) return;
        const events = buffered;
        buffered = [];
        if (JSON.stringify(queryKeys.roster) !== scope) {
          hold.release();
          return;
        }
        const projection = organizationProjection(queryClient.getQueryData<RosterDto>(queryKeys.roster));
        let snapshot = queryClient.getQueryData<ThreadView>(queryKeys.thread(threadId));
        let snapshotTouched = false;
        let invalidateThread = false;
        let invalidateRoster = false;
        const apply = (event: OrganizationEvent) => {
          const productEvent = event as unknown as StoredProductEvent;
          const terminal = isTerminalProductEvent(productEvent);
          if (projectHere.has(event)) projectOrganizationEvent(projection, event, threadId);
          if (event.threadId !== threadId) return;
          if (typeof event.cursor === "number" && Number.isSafeInteger(event.cursor)) {
            cursorRef.current = Math.max(cursorRef.current, event.cursor);
          }
          const knownCursor = snapshot?.cursor;
          const hadSnapshot = snapshot !== undefined;
          if (snapshot) {
            const next = applyProductEventToSnapshot(snapshot, productEvent);
            if (next !== snapshot) {
              snapshot = { ...next, approvals: snapshot.approvals };
              snapshotTouched = true;
            }
          }
          // The end of a run no longer rereads the whole thread when the server has
          // attached the persisted content to its terminal event
          // (`payload.completion`, see
          // `apps/api/src/terminal-event-completion.ts`): the final message,
          // the concluded run's row and its workflow are applied to the
          // cached snapshot. The fallback is explicit: missing block (earlier
          // API), unreadable block, or a run still absent after the
          // patch. No `run.created` in the contract: a delta carries
          // no `RunDto`, `input` / `createdAt` are not invented.
          // The roster is reread only for a run the snapshot does not know
          // (so maybe a bot or a thread the roster ignores
          // too); everything else is already patched in the cache above. An
          // event the snapshot already contained (reconnect replay)
          // rereads nothing.
          const refresh = refreshAfterAppliedEvent({
            event: productEvent,
            hadSnapshot,
            snapshotAfter: snapshot,
            snapshotCursorBefore: knownCursor,
          });
          if (refresh.thread) invalidateThread = true;
          if (refresh.roster) invalidateRoster = true;
          if (
            (event.type === "tool.call" || event.type === "tool.result")
            && typeof event.payload.tool === "string"
            && event.payload.tool.includes("bot_settings_propose")
          ) proposalRuns.add(event.runId);
          if (terminal && proposalRuns.delete(event.runId)) invalidateThread = true;
        };
        const applyHeld = () => { for (const held of hold.release()) apply(held as unknown as OrganizationEvent); };
        // The hold is always the end of the stream: any event it does not
        // take releases it first, the stream order stays that of the patch.
        for (const event of events) {
          const mine = event.threadId === threadId;
          if (mine) liveText.record(event as unknown as StoredProductEvent);
          if (mine && hold.offer(event as unknown as StoredProductEvent, snapshot)) continue;
          applyHeld();
          apply(event);
        }
        if (releaseHeld || hold.dueIn(performance.now()) === 0) applyHeld();
        if (holdTimer !== null) clearTimeout(holdTimer);
        const due = hold.dueIn(performance.now());
        holdTimer = due === null ? null : setTimeout(() => flushBuffered(true), due);
        liveText.publish();
        // One notification tick for both keys: the conversation screen
        // observes the roster and the thread (and the shell's roster patch of
        // the same frame runs in the same batch, `stream-frame.ts`).
        notifyManager.batch(() => {
          writeOrganizationProjection(queryClient, projection);
          if (snapshotTouched && snapshot) queryClient.setQueryData<ThreadView>(queryKeys.thread(threadId), asLocalPatch(snapshot));
        });
        invalidateOrganizationProjection(projection);
        if (invalidateThread) scheduleInvalidate(queryKeys.thread(threadId));
        if (invalidateRoster) scheduleInvalidate(queryKeys.roster);
      };
      stop = subscribeToOrganizationEvents((event) => {
        if (!shellProjectionActive()) projectHere.add(event);
        buffered.push(event);
        scheduleStreamFlush(owner, flushBuffered);
      }, onStatus, initialStreamCursor, onGap);
      return () => {
        flushBuffered(true);
        if (holdTimer !== null) clearTimeout(holdTimer);
      };
    };
    const disposeStart = start();
    return () => {
      disposed = true;
      stop();
      void disposeStart.then((dispose) => dispose?.());
    };
  }, [threadId, queryClient, sessionRevision, snapshotReady]);

  useEffect(() => {
    const snapshot = thread.data;
    if (!threadId || !isCurrentThreadSnapshot(snapshot, threadId)) return;
    // The event can arrive while the first snapshot request is still in
    // flight and before a cache object exists for `setQueryData`. In that
    // narrow case the query-level stale-response guard has nothing to retain;
    // this backfill performs the committed read that recovers the event.
    if (snapshot.cursor < cursorRef.current) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(threadId) });
      return;
    }
    cursorRef.current = Math.max(cursorRef.current, snapshot.cursor);
    setSwitching(false);
  }, [thread.data, threadId, queryClient]);

  return { thread, streaming, switching, loading: switching || thread.isPending, loadOlder, liveText: liveView,
    loadingOlder: olderState.threadId === threadId && olderState.loading,
    olderError: olderState.threadId === threadId && olderState.error };
}
