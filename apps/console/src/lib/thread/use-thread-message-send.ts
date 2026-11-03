import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { attachmentBytes, type MessageAttachmentInput } from "@openedbot/conversation/domain/attachments";
import { prepareMessageSubmission, type IdempotentMessageSubmission } from "@openedbot/conversation/domain/message-submission";
import { api, queryKeys } from "../api";
import { applySendAcceptedToCaches } from "./apply-send-accepted";
import { randomId } from "../random-id";
import type { OutgoingUserInput } from "./thread-anchor";

type Draft = { input: string; attachments: MessageAttachmentInput[]; replyToId?: string | null; planOnly?: boolean };
type Options = {
  threadId?: string | null;
  draft: Draft;
  clearDraft: () => void;
  restoreDraft: (draft: Draft) => void;
  /** Throws to refuse the send; a promise delays it (e.g. a model choice still being saved). */
  beforeSend?: () => void | Promise<void>;
  onError: (error: Error) => void;
};
type Request = {
  threadId: string;
  scope: string;
  rosterKey: string;
  submission: IdempotentMessageSubmission;
  draft: Draft;
};

/** Captures the destination and submitted draft before any asynchronous work. */
export function useThreadMessageSend(options: Options) {
  const queryClient = useQueryClient();
  const scope = JSON.stringify(queryKeys.thread(options.threadId ?? "none"));
  const current = useRef({ ...options, scope });
  current.current = { ...options, scope };
  const pending = useRef<Request | null>(null);
  const [outgoing, setOutgoing] = useState<(OutgoingUserInput & { scope: string }) | null>(null);

  const mutation = useMutation({
    mutationFn: async (request: Request) => {
      await options.beforeSend?.();
      const { submission, threadId } = request;
      return api.sendMessage(threadId, submission.input, submission.attachments,
        submission.idempotencyKey, submission.replyToId, submission.planOnly === true);
    },
    onSuccess: async (accepted, request) => {
      if (pending.current === request) pending.current = null;
      // A workspace switch must not patch another tenant's cache.
      if (request.rosterKey === JSON.stringify(queryKeys.roster)) {
        if (accepted.message) {
          applySendAcceptedToCaches(queryClient, request.threadId, accepted);
        } else {
          await queryClient.invalidateQueries({ queryKey: queryKeys.thread(request.threadId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
        }
      }
      setOutgoing((value) => value?.clientSubmissionId === request.submission.idempotencyKey
        && value.scope === request.scope
        ? accepted.message ? { ...value, messageId: accepted.message.id } : null
        : value);
    },
    onError: (error, request) => {
      if (current.current.scope !== request.scope) return;
      const latest = current.current.draft;
      const empty = !latest.input && !latest.attachments.length && !latest.replyToId;
      if (empty) {
        current.current.restoreDraft(request.draft);
        setOutgoing(null);
      } else {
        // Keep the failed send recoverable without replacing the next draft.
        setOutgoing((value) => value ? { ...value, failed: true } : value);
      }
      current.current.onError(error);
    },
  });

  useEffect(() => {
    pending.current = null;
    setOutgoing(null);
    mutation.reset();
  }, [scope]);

  const prepare = useCallback((draft: Draft): Request => {
    const threadId = current.current.threadId;
    if (!threadId) throw new Error("No active thread");
    const previous = pending.current?.scope === scope ? pending.current.submission : null;
    const submission = prepareMessageSubmission(previous, draft, randomId);
    const request = { threadId, scope, rosterKey: JSON.stringify(queryKeys.roster), submission, draft };
    pending.current = request;
    setOutgoing({ scope, id: `pending:${submission.idempotencyKey}`, text: submission.input,
      clientSubmissionId: submission.idempotencyKey,
      attachments: submission.attachments.map((attachment) => ({ type: "attachment", name: attachment.name,
        contentType: attachment.contentType, kind: attachment.kind, bytes: attachmentBytes(attachment) })) });
    current.current.clearDraft();
    return request;
  }, [scope]);

  const retry = useCallback(() => {
    const request = pending.current;
    if (!request || request.scope !== scope || mutation.isPending) return;
    setOutgoing((value) => value ? { ...value, failed: false } : value);
    mutation.mutate(request);
  }, [scope, mutation.isPending, mutation.mutate]);
  const clearOutgoing = useCallback(() => setOutgoing(null), []);
  const mutate = useCallback((draft: Draft) => mutation.mutate(prepare(draft)), [mutation.mutate, prepare]);
  const mutateAsync = useCallback((draft: Draft) => mutation.mutateAsync(prepare(draft)), [mutation.mutateAsync, prepare]);

  return {
    ...mutation,
    outgoing: outgoing?.scope === scope ? outgoing : null,
    clearOutgoing,
    retry,
    mutate,
    mutateAsync,
  };
}
