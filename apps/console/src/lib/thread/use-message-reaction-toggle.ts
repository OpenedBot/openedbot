import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { MessageReactionEmoji } from "@openedbot/conversation/domain/message-reply";
import { api, queryKeys, type ThreadView } from "../api";
import { patchMessageReaction, reactedByMe } from "./message-reactions";

type ReactionRequest = (threadId: string, messageId: string, emoji: MessageReactionEmoji) => Promise<void>;

/**
 * The reaction toggle of one open thread: optimistic, ordered, reverted on failure.
 *
 * - The cache is patched before the request, so the chips under the reply
 *   and the picker of its action row (two separate shells) agree at once.
 * - The wanted state is read from the cache, not from the clicked button:
 *   a double click inside one frame toggles twice instead of sending the
 *   same PUT twice.
 * - Requests for one (message, emoji) run one after the other: a PUT then
 *   a DELETE can never reach the server in the opposite order and leave the
 *   row the UI just removed.
 * - A failed request reverts only its own toggle (when nothing toggled it
 *   since), then rethrows so the caller can say so.
 * - Once a key's queue drains, the thread is reread to pick up the
 *   other members' reactions; reactions emit no stream event.
 */
export function useMessageReactionToggle(
  threadId: string | undefined,
  requests: { add: ReactionRequest; remove: ReactionRequest } = {
    add: api.addMessageReaction,
    remove: api.removeMessageReaction,
  },
): (messageId: string, emoji: MessageReactionEmoji, active: boolean) => Promise<void> {
  const queryClient = useQueryClient();
  const queues = useRef(new Map<string, Promise<void>>());
  const requestsRef = useRef(requests);
  requestsRef.current = requests;

  // A thread switch must not chain the next thread's requests behind these.
  useEffect(() => () => queues.current.clear(), [threadId]);

  return useCallback(async (messageId: string, emoji: MessageReactionEmoji, active: boolean) => {
    if (!threadId) return;
    const key = queryKeys.thread(threadId);
    // A read already in flight predates this toggle: its answer would put the old state back.
    await queryClient.cancelQueries({ queryKey: key, exact: true });
    const cached = queryClient.getQueryData<ThreadView>(key)?.messages.find((message) => message.id === messageId);
    const on = cached ? !reactedByMe(cached.reactions, emoji) : !active;
    queryClient.setQueryData<ThreadView>(key, (view) => view ? patchMessageReaction(view, messageId, emoji, on) : view);

    const queueKey = `${messageId}\u0000${emoji}`;
    const previous = queues.current.get(queueKey) ?? Promise.resolve();
    const send = previous.catch(() => {}).then(() => on
      ? requestsRef.current.add(threadId, messageId, emoji)
      : requestsRef.current.remove(threadId, messageId, emoji));
    queues.current.set(queueKey, send);
    try {
      await send;
    } catch (error) {
      queryClient.setQueryData<ThreadView>(key, (view) => {
        if (!view) return view;
        const message = view.messages.find((row) => row.id === messageId);
        // A later toggle already moved it: leave that one in charge.
        if (!message || reactedByMe(message.reactions, emoji) !== on) return view;
        return patchMessageReaction(view, messageId, emoji, !on);
      });
      throw error;
    } finally {
      if (queues.current.get(queueKey) === send) {
        queues.current.delete(queueKey);
        void queryClient.invalidateQueries({ queryKey: key, exact: true });
      }
    }
  }, [queryClient, threadId]);
}
