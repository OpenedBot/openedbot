import { nativeBridge } from "../platform";
import { normalizeWorkflowCounters } from "@/lib/run/workflow-display";
import type { CreateMessageVersionInput, InboxDto, MessageVersionCreatedDto, MessageVersionFamilyListDto, ThreadCompactResult, WorkflowHistoryPageDto } from "@openedbot/contracts-api";
import type { MessageAttachmentInput } from "@openedbot/conversation/domain/attachments";
import { API_ORIGIN, ApiError, rawApiFetch, authHeadersFor, cloudHeaders, request } from "./http";
import type { SendMessageResult, ThreadView, WorkflowRecoveryResult } from "./types";

/** The browser's IANA zone, or `null` when it does not say (never guessed as UTC). */
function browserZone(): string | null {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
}
const withTimeZone = (zone: string | null) => (zone ? { timeZone: zone } : {});

export const threadsApi = {
  thread: async (threadId: string, before?: string): Promise<ThreadView> => {
    const query = before ? `?before=${encodeURIComponent(before)}` : "";
    const view = await request<ThreadView>(`/api/threads/${threadId}/history${query}`);
    return { ...view, workflows: view.workflows?.map(normalizeWorkflowCounters) };
  },
  markThreadRead: (threadId: string, readThrough: string) =>
    request<void>(`/api/threads/${threadId}/read`, {
      method: "POST",
      body: JSON.stringify({ readThrough }),
    }),
  markThreadUnread: (threadId: string) =>
    request<void>(`/api/threads/${threadId}/read`, { method: "DELETE" }),
  hideThread: (threadId: string) =>
    request<void>(`/api/threads/${threadId}/hidden`, { method: "PUT" }),
  showThread: (threadId: string) =>
    request<void>(`/api/threads/${threadId}/hidden`, { method: "DELETE" }),
  /**
   * `attachments` is NOT set when there is nothing to attach: an empty
   * array in the body would make the request diverge from what mobile and
   * the tests from before US-CHAT-08 send, for zero extra information.
   */
  sendMessage: (
    threadId: string,
    input: string,
    attachments: readonly MessageAttachmentInput[],
    idempotencyKey: string,
    replyToId?: string | null,
    /** « Planifier d'abord »: this turn only makes a plan, whatever the bot's mode. */
    planOnly = false,
  ) =>
    request<SendMessageResult>(`/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        input,
        ...(attachments.length ? { attachments } : {}),
        ...(replyToId ? { replyToId } : {}),
        ...(planOnly ? { planOnly: true } : {}),
        // The person's zone, for a routine the bot schedules from this message (0187).
        ...withTimeZone(browserZone()),
      }),
    }),
  messageVersions: (threadId: string) =>
    request<MessageVersionFamilyListDto>(`/api/threads/${threadId}/message-versions`),
  createMessageVersion: (
    threadId: string,
    messageId: string,
    input: CreateMessageVersionInput,
    idempotencyKey: string,
  ) => request<MessageVersionCreatedDto>(
    `/api/threads/${threadId}/messages/${messageId}/versions`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input),
    },
  ),
  addMessageReaction: (threadId: string, messageId: string, emoji: string) =>
    request<void>(`/api/threads/${threadId}/messages/${messageId}/reactions`, {
      method: "PUT",
      body: JSON.stringify({ emoji }),
    }),
  removeMessageReaction: (threadId: string, messageId: string, emoji: string) =>
    request<void>(`/api/threads/${threadId}/messages/${messageId}/reactions`, {
      method: "DELETE",
      body: JSON.stringify({ emoji }),
    }),
  cancelRun: (runId: string) => request<void>(`/api/runs/${runId}/cancel`, { method: "POST" }),
  /** Summarizes a room's history (DEV-332). Slow: up to a few minutes. */
  // The route gives itself 250 s (`COMPACT_REQUEST_DEADLINE_MS`): the client waits
  // a little longer, so it reads the response rather than giving up before it.
  compactThread: (threadId: string) =>
    request<ThreadCompactResult>(`/api/threads/${threadId}/compact`, { method: "POST" }, { timeoutMs: 270_000 }),
  /** The execution history, page by page (opaque cursor `<iso>|<uuid>`). */
  workflowHistory: (input: { status?: "all" | "active" | "attention"; cursor?: string | null; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (input.status && input.status !== "all") query.set("status", input.status);
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.limit) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return request<WorkflowHistoryPageDto>(`/api/workflows${suffix}`);
  },
  inbox: () => request<InboxDto>("/api/inbox"),
  reconcileWorkflow: (workflowId: string) =>
    request<WorkflowRecoveryResult>(`/api/workflows/${workflowId}/reconcile`, { method: "POST" }),
  abandonWorkflow: (workflowId: string) =>
    request<void>(`/api/workflows/${workflowId}/abandon`, { method: "POST" }),
  retryWorkflow: (workflowId: string) =>
    request<WorkflowRecoveryResult>(`/api/workflows/${workflowId}/retry`, {
      method: "POST",
      body: JSON.stringify({ confirmDuplicateRisk: true }),
    }),
  /**
   * An attachment's bytes (US-CHAT-08).
   *
   * A `Blob` and not a URL: the token stays in a header, as everywhere
   * other than the SSE stream. The caller turns it into a `blob:` URL and revokes it
   *: `AttachmentImage` (`thread-timeline.tsx`) owns that cycle.
   */
  attachment: async (attachmentId: string): Promise<Blob> => {
    const bridge = nativeBridge();
    const bearer = bridge ? (await bridge.readAccessToken()) ?? "" : "";
    const response = await rawApiFetch(`${API_ORIGIN}/api/attachments/${attachmentId}`, {
      credentials: bridge ? "omit" : "include",
      headers: { ...cloudHeaders("GET", true, bridge !== null), ...authHeadersFor(bearer) },
    });
    if (!response.ok) throw new ApiError(response.status, "Pièce jointe illisible.", "ATTACHMENT_UNREADABLE");
    return response.blob();
  },
  eventsUrl: (_threadId: string, cursor: number) => `${API_ORIGIN}/api/events?cursor=${cursor}`,
};
