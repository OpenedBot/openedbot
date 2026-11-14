import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { latestThreadReadThrough, threadHasStreamingRun, type ThreadReadActivity } from "@/lib/thread/thread-read";
import { findRosterThread, markRosterThreadRead } from "@openedbot/conversation/domain/thread-snapshot-mutations";
import type { RosterDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../api";
import { scheduleInvalidate } from "../query-client";

type ReadVisibility = {
  visibilityState: string;
  hasFocus(): boolean;
};

/**
 * While a run scrolls, the watermark advances on every event: it is
 * acknowledged only once per interval, then at the run's settlement with the
 * latest watermark. Opening the thread acknowledges at once.
 */
export const STREAMING_READ_ACK_INTERVAL_MS = 10_000;

export function canAcknowledgeThreadRead(documentState: ReadVisibility | null | undefined): boolean {
  // `document.hasFocus()` is false as soon as the operator clicks another
  // pane (for example Codex next to the browser), even though this visible
  // conversation remains on screen and keeps streaming. Requiring keyboard
  // focus marked the currently open thread unread while its answer was being
  // shown. Page visibility is the browser signal for whether it can be seen.
  return documentState?.visibilityState === "visible";
}

/**
 * Acknowledges only what the user had a chance to see. The
 * watermark comes from the snapshot, never from the local clock, and failure puts
 * the attempt back in play on the next focus without hiding the unread dot.
 */
export function useMarkThreadRead(
  threadId: string | undefined,
  activity: ThreadReadActivity | null | undefined,
): void {
  const queryClient = useQueryClient();
  const readThrough = latestThreadReadThrough(activity);
  const streaming = threadHasStreamingRun(activity);
  const submitted = useRef<string | null>(null);
  const ackedThread = useRef<string | null>(null);
  const deferredSince = useRef<number | null>(null);

  useEffect(() => {
    if (!threadId || !readThrough) return;
    const key = `${threadId}:${readThrough}`;
    const acknowledge = () => {
      if (!canAcknowledgeThreadRead(globalThis.document) || submitted.current === key) return;
      submitted.current = key;
      ackedThread.current = threadId;
      deferredSince.current = null;
      void api.markThreadRead(threadId, readThrough)
        .then(() => {
          // What the server would answer, applied in the cache: the thread row
          // becomes read. Rereading it cost a `GET /api/bots` per thread
          // open.
          const current = queryClient.getQueryData<RosterDto>(queryKeys.roster);
          if (current && findRosterThread(current, threadId)) {
            queryClient.setQueryData<RosterDto>(queryKeys.roster, (roster) => (
              roster ? markRosterThreadRead(roster, threadId) : roster
            ));
            return;
          }
          // Row absent from the cache (the startup `GET /api/bots` has not
          // come back yet, or a thread outside the roster). A read already in flight stays
          // valid: served after the `POST …/read`, it reflects `read_at`;
          // served before, the coalesced reread (without cancelling the one in flight)
          // catches up. An immediate `invalidateQueries` cancelled the startup `/bots`
          // and restarted it: two requests for one.
          scheduleInvalidate(queryKeys.roster);
        })
        .catch(() => {
          if (submitted.current === key) submitted.current = null;
        });
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (streaming && ackedThread.current === threadId) {
      // Run in progress on a thread already acknowledged: it is deferred, without pushing
      // the deadline back on every event.
      const now = Date.now();
      deferredSince.current ??= now;
      const wait = Math.max(0, deferredSince.current + STREAMING_READ_ACK_INTERVAL_MS - now);
      if (wait > 0) timer = setTimeout(acknowledge, wait);
      else acknowledge();
    } else {
      acknowledge();
    }
    globalThis.window?.addEventListener("focus", acknowledge);
    globalThis.document?.addEventListener("visibilitychange", acknowledge);
    return () => {
      if (timer) clearTimeout(timer);
      globalThis.window?.removeEventListener("focus", acknowledge);
      globalThis.document?.removeEventListener("visibilitychange", acknowledge);
    };
  }, [queryClient, readThrough, streaming, threadId]);
}
