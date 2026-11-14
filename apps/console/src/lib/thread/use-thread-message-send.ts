import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { attachmentBytes } from "@openedbot/conversation/domain/attachments";
import { prepareMessageSubmission } from "@openedbot/conversation/domain/message-submission";
import { api, ApiError, queryKeys } from "../api";
import { applySendAcceptedToCaches } from "./apply-send-accepted";
import { randomId } from "../random-id";
import { readCloudSession } from "../session/cloud-session";
import type { OutgoingUserInput } from "./thread-anchor";
import { useT } from "../i18n";
import { pendingMessageStore, type PendingMessageDraft as Draft, type PendingMessageRequest as Request } from "./pending-message-store";

type Options = {
  threadId?: string | null;
  draft: Draft;
  clearDraft: () => void;
  restoreDraft: (draft: Draft) => void;
  /** Throws to refuse the send; a promise delays it (e.g. a model choice still being saved). */
  beforeSend?: () => void | Promise<void>;
  onError: (error: Error) => void;
};
const unconfirmedSends = pendingMessageStore.memory;

function unconfirmedKey(request: Pick<Request, "owner" | "scope">): string {
  return `${request.owner}|${request.scope}`;
}

function forgetPersisted(request: Request): Promise<boolean> {
  return pendingMessageStore.remove(request).then(() => true).catch((error) => {
    // A stale record remains replayable with the same key, never a duplicate.
    console.error("Could not remove the confirmed pending message", error);
    return false;
  });
}

function outgoingFor(request: Request, failed?: boolean): OutgoingUserInput & { scope: string } {
  const { submission, scope } = request;
  return { scope, id: `pending:${submission.idempotencyKey}`, text: submission.input,
    clientSubmissionId: submission.idempotencyKey,
    attachments: submission.attachments.map((attachment) => ({ type: "attachment", name: attachment.name,
      contentType: attachment.contentType, kind: attachment.kind, bytes: attachmentBytes(attachment) })),
    ...(failed ? { failed: true } : {}) };
}

/** Captures the destination and submitted draft before any asynchronous work. */
export function useThreadMessageSend(options: Options) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const scope = JSON.stringify(queryKeys.thread(options.threadId ?? "none"));
  const owner = readCloudSession()?.userId ?? "";
  const memoryKey = unconfirmedKey({ owner, scope });
  const current = useRef({ ...options, scope, owner });
  current.current = { ...options, scope, owner };
  const mounted = useRef(true);
  const pending = useRef<Request | null>(null);
  const [restoring, setRestoring] = useState(Boolean(owner && options.threadId));
  const [outgoing, setOutgoing] = useState<(OutgoingUserInput & { scope: string }) | null>(null);

  const mutation = useMutation({
    mutationFn: async (request: Request) => {
      try {
        await pendingMessageStore.write(request);
      } catch {
        throw new ApiError(0, t("threadScreen.pendingSaveFailed"), "MESSAGE_RECOVERY_STORAGE_UNAVAILABLE");
      }
      request.persisted = true;
      if (request.generation !== pendingMessageStore.generation || request.owner !== current.current.owner
        || request.rosterKey !== JSON.stringify(queryKeys.roster)) throw new Error("Message session changed before dispatch");
      if (mounted.current && current.current.scope === request.scope) {
        setOutgoing(outgoingFor(request));
        // The durable write may take time: never erase words typed meanwhile.
        const source = prepareMessageSubmission(null, request.draft, () => request.submission.idempotencyKey);
        if (prepareMessageSubmission(source, current.current.draft, randomId) === source) {
          current.current.clearDraft();
        }
      }
      await options.beforeSend?.();
      if (request.generation !== pendingMessageStore.generation || request.owner !== readCloudSession()?.userId
        || request.rosterKey !== JSON.stringify(queryKeys.roster)) throw new Error("Message session changed before dispatch");
      const { submission, threadId } = request;
      return api.sendMessage(threadId, submission.input, submission.attachments,
        submission.idempotencyKey, submission.replyToId, submission.planOnly === true);
    },
    onSuccess: async (accepted, request) => {
      if (pending.current === request) pending.current = null;
      const key = unconfirmedKey(request);
      if (unconfirmedSends.get(key)?.request === request) unconfirmedSends.delete(key);
      const removed = forgetPersisted(request);
      // A workspace switch must not patch another tenant's cache.
      if (request.owner === readCloudSession()?.userId && request.rosterKey === JSON.stringify(queryKeys.roster)) {
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
      // A newer send can finish while an older ambiguous send still waits on
      // disk. Offer that older request again without requiring navigation.
      const canRestore = () => mounted.current && current.current.scope === request.scope
        && current.current.owner === request.owner && request.generation === pendingMessageStore.generation
        && !pending.current;
      if (await removed && canRestore()) {
        try {
          const left = await pendingMessageStore.read(request.owner, request.scope);
          if (left && canRestore()) {
            if (left.threadId !== request.threadId) throw new Error("Pending message destination does not match");
            pending.current = left;
            unconfirmedSends.set(key, { request: left, failed: true });
            setOutgoing(outgoingFor(left, true));
          }
        } catch {
          if (canRestore()) current.current.onError(new ApiError(0, t("threadScreen.pendingReadFailed"), "MESSAGE_RECOVERY_READ_FAILED"));
        }
      }
    },
    onError: (error, request) => {
      const key = unconfirmedKey(request);
      const entry = unconfirmedSends.get(key);
      if (entry?.request === request) entry.failed = true;
      // Another thread is shown, or none: the send waits there for its return.
      if (!mounted.current || current.current.scope !== request.scope || current.current.owner !== request.owner
        || request.generation !== pendingMessageStore.generation) return;
      if (!request.persisted) {
        if (entry?.request === request) unconfirmedSends.delete(key);
        if (pending.current === request) pending.current = null;
        setOutgoing(null);
        current.current.onError(error);
        return;
      }
      const latest = current.current.draft;
      const empty = !latest.input && !latest.attachments.length && !latest.replyToId;
      if (empty) {
        if (entry?.request === request) unconfirmedSends.delete(key);
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
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    mutation.reset();
    // Back on a thread whose send was left unconfirmed: show it again, failed
    // or still in flight, with the same submission for the retry.
    let cancelled = false;
    const left = unconfirmedSends.get(memoryKey);
    pending.current = left?.request ?? null;
    setOutgoing(left ? outgoingFor(left.request, left.failed) : null);
    setRestoring(false);
    if (!left && owner && options.threadId) {
      setRestoring(true);
      void pendingMessageStore.read(owner, scope).then((request) => {
        if (cancelled || !request || pending.current) return;
        if (request.threadId !== current.current.threadId) throw new Error("Pending message destination does not match");
        pending.current = request;
        unconfirmedSends.set(memoryKey, { request, failed: true });
        setOutgoing(outgoingFor(request, true));
      }).catch(() => {
        if (!cancelled) current.current.onError(new ApiError(0, t("threadScreen.pendingReadFailed"), "MESSAGE_RECOVERY_READ_FAILED"));
      }).finally(() => {
        if (!cancelled) setRestoring(false);
      });
    }
    return () => { cancelled = true; };
  }, [scope, owner]);

  const prepare = useCallback((draft: Draft): Request => {
    const threadId = current.current.threadId;
    if (!threadId) throw new Error("No active thread");
    const previous = pending.current?.scope === scope ? pending.current.submission : null;
    const submission = prepareMessageSubmission(previous, draft, randomId);
    const request: Request = { threadId, scope, owner, generation: pendingMessageStore.generation,
      rosterKey: JSON.stringify(queryKeys.roster), submission, draft: current.current.draft };
    pending.current = request;
    unconfirmedSends.set(memoryKey, { request, failed: false });
    return request;
  }, [scope, owner, memoryKey, t]);

  const retry = useCallback(() => {
    const request = pending.current;
    if (!request || request.scope !== scope || mutation.isPending) return;
    unconfirmedSends.set(unconfirmedKey(request), { request, failed: false });
    setOutgoing((value) => value ? { ...value, failed: false } : value);
    mutation.mutate(request);
  }, [scope, mutation.isPending, mutation.mutate]);
  // The timeline now holds the message: nothing is left to recover.
  const clearOutgoing = useCallback(() => {
    const submissionId = outgoing?.clientSubmissionId;
    if (!submissionId) return;
    const request = unconfirmedSends.get(memoryKey)?.request;
    // A newer send may already be waiting on its durable write. Clearing the
    // previous bubble must not discard that newer request's recovery copy.
    if (request?.submission.idempotencyKey === submissionId) {
      forgetPersisted(request);
      unconfirmedSends.delete(memoryKey);
      if (pending.current === request) pending.current = null;
    }
    setOutgoing((value) => value?.clientSubmissionId === submissionId ? null : value);
  }, [memoryKey, outgoing?.clientSubmissionId]);
  const mutate = useCallback((draft: Draft) => {
    try { mutation.mutate(prepare(draft)); } catch (error) {
      current.current.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }, [mutation.mutate, prepare]);
  const mutateAsync = useCallback(async (draft: Draft) => mutation.mutateAsync(prepare(draft)), [mutation.mutateAsync, prepare]);

  return {
    ...mutation,
    isPending: mutation.isPending || restoring,
    outgoing: outgoing?.scope === scope ? outgoing : null,
    clearOutgoing,
    retry,
    mutate,
    mutateAsync,
  };
}
