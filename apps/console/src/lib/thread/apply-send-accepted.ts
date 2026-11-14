import { notifyManager, type QueryClient } from "@tanstack/react-query";
import type { RosterDto, SendMessageAccepted } from "@openedbot/contracts-api";
import {
  applySendAcceptedToRoster,
  applySendAcceptedToSnapshot,
} from "@openedbot/conversation/domain/thread-snapshot-mutations";
import { queryKeys, type ThreadView } from "../api";

/**
 * Patches the open thread and the roster from the 202. Falls back to a full
 * reread when the payload has no `message` (older API).
 *
 * Query observers use an external store. Their notifications are synchronous;
 * wrapping this in startTransition cannot make a large transcript cheap.
 * Keep the optimistic bubble independent and preserve unchanged cache rows.
 *
 * Both writes share one notification batch: each `setQueryData`
 * otherwise flushes its observers in its own `setTimeout(0)` tick, so the
 * conversation screen, which observes both keys, rendered twice for one 202.
 */
export function applySendAcceptedToCaches(
  queryClient: QueryClient,
  threadId: string,
  accepted: SendMessageAccepted,
): void {
  globalThis.window?.__openedbotThreadPerf?.recordRunAccepted(accepted.runId);
  if (!accepted.message) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.thread(threadId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
    return;
  }
  notifyManager.batch(() => {
    queryClient.setQueryData<ThreadView>(queryKeys.thread(threadId), (current) =>
      current ? { ...applySendAcceptedToSnapshot(current, accepted), approvals: current.approvals } : current,
    );
    queryClient.setQueryData<RosterDto>(queryKeys.roster, (current) =>
      current
        ? applySendAcceptedToRoster(current, { threadId, accepted, openThreadId: threadId })
        : current,
    );
  });
}
