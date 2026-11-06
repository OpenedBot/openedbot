import { nativeBridge } from "../platform";
import { normalizeWorkflowCounters } from "@/lib/run/workflow-display";
import type { CreateMessageVersionInput, InboxDto, MessageVersionCreatedDto, MessageVersionFamilyListDto, ThreadCompactResult, WorkflowHistoryPageDto } from "@openedbot/contracts-api";
import type { MessageAttachmentInput } from "@openedbot/conversation/domain/attachments";
import { API_ORIGIN, ApiError, rawApiFetch, authHeadersFor, cloudHeaders, request } from "./http";
import type { SendMessageResult, ThreadView, WorkflowRecoveryResult } from "./types";

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
   * `attachments` n'est PAS posé quand il n'y a rien à joindre : un tableau
   * vide dans le corps ferait diverger la requête de celle que le mobile et
   * les tests d'avant US-CHAT-08 envoient, pour zéro information de plus.
   */
  sendMessage: (
    threadId: string,
    input: string,
    attachments: readonly MessageAttachmentInput[],
    idempotencyKey: string,
    replyToId?: string | null,
    /** « Planifier d'abord » : ce tour ne fait qu'un plan, quel que soit le mode du bot. */
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
  /** Résume l'historique d'un salon (DEV-332). Lent : jusqu'à quelques minutes. */
  // La route se donne 250 s (`COMPACT_REQUEST_DEADLINE_MS`) : le client attend
  // un peu plus, pour lire sa réponse plutôt que d'abandonner avant elle.
  compactThread: (threadId: string) =>
    request<ThreadCompactResult>(`/api/threads/${threadId}/compact`, { method: "POST" }, { timeoutMs: 270_000 }),
  /** L'historique des exécutions, page par page (curseur opaque `<iso>|<uuid>`). */
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
   * Les octets d'une pièce jointe (US-CHAT-08).
   *
   * Un `Blob` et pas une URL : le jeton reste dans un en-tête, comme partout
   * ailleurs que le flux SSE. L'appelant en fait une `blob:` URL et la révoque
   *: c'est `AttachmentImage` (`thread-timeline.tsx`) qui tient ce cycle.
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
