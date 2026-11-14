import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SendMessageAccepted } from "@openedbot/contracts-api";
import type { MessageAttachmentInput } from "@openedbot/conversation/domain/attachments";
import { api } from "../../../src/lib/api";
import { useThreadMessageSend } from "../../../src/lib/thread/use-thread-message-send";
import { pendingMessageStore, type PendingMessageRequest } from "../../../src/lib/thread/pending-message-store";
import { I18nProvider } from "../../../src/lib/i18n";
import { saveCloudSession } from "../../../src/lib/session/cloud-session";

type Draft = { input: string; attachments: MessageAttachmentInput[]; replyToId?: string | null };
const empty: Draft = { input: "", attachments: [] };
const accepted: SendMessageAccepted = { runId: "run", workflowId: "wf", status: "queued",
  message: { id: "persisted", role: "user", content: [{ type: "text", text: "Hello" }], runId: "run", createdAt: "2026-09-15T00:00:00Z" } };
const attachment: MessageAttachmentInput = { name: "next.txt", contentType: "text/plain", kind: "document", content: [{ type: "text", text: "next attachment" }] };
let restoreSpy: ReturnType<typeof spyOn> | undefined;
const disk = new Map<string, PendingMessageRequest>();
let writeSpy: ReturnType<typeof spyOn<typeof pendingMessageStore, "write">>;
let readSpy: ReturnType<typeof spyOn<typeof pendingMessageStore, "read">>;
let removeSpy: ReturnType<typeof spyOn<typeof pendingMessageStore, "remove">>;
beforeEach(() => {
  disk.clear();
  pendingMessageStore.memory.clear();
  saveCloudSession({ userId: "sender", organizationId: "organization", csrfToken: "csrf" });
  writeSpy = spyOn(pendingMessageStore, "write").mockImplementation(async (request) => {
    disk.set(request.submission.idempotencyKey, structuredClone(request));
  });
  readSpy = spyOn(pendingMessageStore, "read").mockImplementation(async (owner, scope) => {
    const request = [...disk.values()].find((entry) => entry.owner === owner && entry.scope === scope);
    return request ? { ...structuredClone(request), persisted: true, generation: pendingMessageStore.generation } : null;
  });
  removeSpy = spyOn(pendingMessageStore, "remove").mockImplementation(async (request) => {
    disk.delete(request.submission.idempotencyKey);
  });
});
afterEach(() => { cleanup(); restoreSpy?.mockRestore(); writeSpy.mockRestore(); readSpy.mockRestore(); removeSpy.mockRestore(); });

function harness(initial = "thread-a") {
  let resolve!: (value: SendMessageAccepted) => void;
  let reject!: (error: Error) => void;
  const response = new Promise<SendMessageAccepted>((yes, no) => { resolve = yes; reject = no; });
  const call = spyOn(api, "sendMessage").mockImplementation(() => response);
  restoreSpy = call;
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const hook = renderHook(({ threadId }) => {
    const [draft, setDraft] = useState<Draft>({ input: "Hello", attachments: [] });
    const send = useThreadMessageSend({ threadId, draft, clearDraft: () => setDraft(empty), restoreDraft: setDraft, onError: () => {} });
    return { send, draft, setDraft };
  }, { initialProps: { threadId: initial }, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><I18nProvider>{children}</I18nProvider></QueryClientProvider> });
  return { ...hook, resolve, reject, call };
}

describe("thread send owns only its submitted draft", () => {
  test("clears after saving the recovery copy, then preserves the next text, attachment and reply after 202", async () => {
    const h = harness();
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));
    expect(h.result.current.draft).toEqual(empty);
    expect(disk.size).toBe(1);
    const next = { input: "Next", attachments: [attachment], replyToId: "reply-next" };
    act(() => h.result.current.setDraft(next));
    await act(async () => h.resolve(accepted));
    await waitFor(() => expect(h.result.current.send.isSuccess).toBe(true));
    expect(h.result.current.draft).toEqual(next);
    expect(h.result.current.send.outgoing?.messageId).toBe("persisted");
    expect(disk.size).toBe(0);
  });

  test("failure preserves a newer draft and exposes the failed send for retry", async () => {
    const h = harness();
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));
    act(() => h.result.current.setDraft({ input: "Next", attachments: [attachment] }));
    await act(async () => h.reject(new Error("network")));
    await waitFor(() => expect(h.result.current.send.isError).toBe(true));
    expect(h.result.current.draft.input).toBe("Next");
    expect(h.result.current.send.outgoing).toMatchObject({ text: "Hello", failed: true });
    const key = h.call.mock.calls[0]![3];
    h.call.mockResolvedValueOnce(accepted);
    act(() => h.result.current.send.retry());
    await waitFor(() => expect(h.result.current.send.isSuccess).toBe(true));
    expect(h.call.mock.calls[1]![3]).toBe(key);
    expect(h.result.current.draft).toEqual({ input: "Next", attachments: [attachment] });
  });

  test("failure restores an untouched empty composer and reuses its key on retry", async () => {
    const h = harness();
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));
    const key = h.call.mock.calls[0]![3];
    await act(async () => h.reject(new Error("network")));
    await waitFor(() => expect(h.result.current.draft.input).toBe("Hello"));
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(2));
    expect(h.call.mock.calls[1]![3]).toBe(key);
  });

  test("accepting a newer message exposes an older unconfirmed submission without a remount", async () => {
    const h = harness("thread-multiple");
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));
    const originalKey = h.call.mock.calls[0]![3];
    act(() => h.result.current.setDraft({ input: "Next", attachments: [attachment] }));
    await act(async () => h.reject(new Error("network")));
    await waitFor(() => expect(h.result.current.send.outgoing?.failed).toBe(true));
    h.call.mockResolvedValueOnce(accepted);
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(h.result.current.send.isSuccess).toBe(true));
    expect(disk.size).toBe(1);
    expect(h.result.current.send.outgoing).toMatchObject({ text: "Hello", failed: true, clientSubmissionId: originalKey });
    h.call.mockResolvedValueOnce(accepted);
    act(() => h.result.current.send.retry());
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(3));
    expect(h.call.mock.calls[2]![3]).toBe(originalKey);
    await waitFor(() => expect(disk.size).toBe(0));
  });

  test("navigation during recovery cannot surface another thread's pending message", async () => {
    const h = harness("thread-left");
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));
    const older = [...disk.values()][0]!;
    act(() => h.result.current.setDraft({ input: "Next", attachments: [] }));
    await act(async () => h.reject(new Error("network")));
    await waitFor(() => expect(h.result.current.send.isError).toBe(true));
    let resolveRead!: (request: PendingMessageRequest) => void;
    readSpy.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    h.call.mockResolvedValueOnce(accepted);
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(typeof resolveRead).toBe("function"));
    h.rerender({ threadId: "thread-right" });
    act(() => h.result.current.setDraft({ input: "Right thread draft", attachments: [] }));
    await act(async () => resolveRead(older));
    await waitFor(() => expect(h.result.current.send.isPending).toBe(false));
    expect(h.result.current.send.outgoing).toBeNull();
    expect(h.result.current.draft.input).toBe("Right thread draft");
    expect(disk.size).toBe(1);
  });

  test("changing threads while a POST is pending cannot clear the new draft", async () => {
    const h = harness();
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));
    h.rerender({ threadId: "thread-b" });
    act(() => h.result.current.setDraft({ input: "For B", attachments: [] }));
    await act(async () => h.resolve(accepted));
    expect(h.result.current.draft.input).toBe("For B");
    expect(h.result.current.send.outgoing).toBeNull();
    expect(h.call.mock.calls[0]![0]).toBe("thread-a");
  });

  test("a send that fails while another thread is shown comes back failed, with its key", async () => {
    const h = harness();
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));
    const key = h.call.mock.calls[0]![3];
    h.rerender({ threadId: "thread-b" });
    await act(async () => h.reject(new Error("network")));
    expect(h.result.current.send.outgoing).toBeNull();

    h.rerender({ threadId: "thread-a" });
    await waitFor(() => expect(h.result.current.send.outgoing).toMatchObject({ text: "Hello", failed: true }));
    h.call.mockResolvedValueOnce(accepted);
    act(() => h.result.current.send.retry());
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(2));
    expect(h.call.mock.calls[1]![0]).toBe("thread-a");
    expect(h.call.mock.calls[1]![3]).toBe(key);
  });

  test("a send that fails after the screen unmounted is offered again on the next mount", async () => {
    const h = harness("thread-c");
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));
    h.unmount();
    await act(async () => h.reject(new Error("network")));

    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const again = renderHook(() => useThreadMessageSend({ threadId: "thread-c", draft: empty, clearDraft: () => {}, restoreDraft: () => {}, onError: () => {} }),
      { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><I18nProvider>{children}</I18nProvider></QueryClientProvider> });
    await waitFor(() => expect(again.result.current.outgoing).toMatchObject({ text: "Hello", failed: true }));
  });

  test("a crash loses memory but keeps the submission, attachments and idempotency key for explicit retry", async () => {
    const h = harness("thread-crash");
    const draft = { input: "Recover me", attachments: [attachment], replyToId: "quoted", planOnly: true };
    act(() => h.result.current.send.mutate(draft));
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));
    const key = h.call.mock.calls[0]![3];
    h.unmount();
    pendingMessageStore.memory.clear();
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const again = renderHook(() => useThreadMessageSend({ threadId: "thread-crash", draft: empty, clearDraft: () => {}, restoreDraft: () => {}, onError: () => {} }),
      { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><I18nProvider>{children}</I18nProvider></QueryClientProvider> });
    await waitFor(() => expect(again.result.current.outgoing).toMatchObject({ text: "Recover me", failed: true, clientSubmissionId: key }));
    expect(h.call).toHaveBeenCalledTimes(1);
    h.call.mockResolvedValueOnce(accepted);
    act(() => again.result.current.retry());
    await waitFor(() => expect(again.result.current.isSuccess).toBe(true));
    expect(h.call.mock.calls[1]).toEqual(["thread-crash", draft.input, draft.attachments, key, "quoted", true]);
    expect(disk.size).toBe(0);
  });

  test("storage failure preserves the composer and never dispatches the message", async () => {
    writeSpy.mockRejectedValueOnce(new Error("quota exceeded"));
    const h = harness("thread-full");
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(h.result.current.send.isError).toBe(true));
    expect(h.call).not.toHaveBeenCalled();
    expect(h.result.current.draft.input).toBe("Hello");
    expect(h.result.current.send.outgoing).toBeNull();
    expect(h.result.current.send.error).toMatchObject({ code: "MESSAGE_RECOVERY_STORAGE_UNAVAILABLE" });
  });

  test("words typed during the durable write are not erased", async () => {
    let persisted!: () => void;
    writeSpy.mockImplementationOnce(() => new Promise<void>((resolve) => { persisted = resolve; }));
    const h = harness("thread-slow-storage");
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    expect(h.result.current.draft.input).toBe("Hello");
    act(() => h.result.current.setDraft({ input: "Next", attachments: [attachment] }));
    await act(async () => persisted());
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));
    expect(h.result.current.draft.input).toBe("Next");
    await act(async () => h.resolve(accepted));
  });

  test("trimming or enriching the submitted text still clears the unchanged composer", async () => {
    const h = harness("thread-normalized");
    act(() => h.result.current.setDraft({ input: "  Hello  ", attachments: [] }));
    act(() => h.result.current.send.mutate({ input: "Goal: help\nHello", attachments: [] }));
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));
    expect(h.result.current.draft).toEqual(empty);
    expect(h.call.mock.calls[0]![1]).toBe("Goal: help\nHello");
    await act(async () => h.reject(new Error("network")));
    await waitFor(() => expect(h.result.current.draft.input).toBe("  Hello  "));
  });

  test("another user cannot recover the first user's pending message", async () => {
    const h = harness("thread-private");
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));
    h.unmount();
    pendingMessageStore.memory.clear();
    saveCloudSession({ userId: "other-user", organizationId: "organization", csrfToken: "other" });
    const client = new QueryClient();
    const again = renderHook(() => useThreadMessageSend({ threadId: "thread-private", draft: empty, clearDraft: () => {}, restoreDraft: () => {}, onError: () => {} }),
      { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><I18nProvider>{children}</I18nProvider></QueryClientProvider> });
    await waitFor(() => expect(again.result.current.isPending).toBe(false));
    expect(again.result.current.outgoing).toBeNull();
    expect(disk.size).toBe(1);
    expect(h.call).toHaveBeenCalledTimes(1);
  });

  test("sign-out during persistence prevents dispatch under another identity", async () => {
    let persisted!: () => void;
    writeSpy.mockImplementationOnce(() => new Promise<void>((resolve) => { persisted = resolve; }));
    const h = harness("thread-sign-out");
    act(() => h.result.current.send.mutate(h.result.current.draft));
    await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    await pendingMessageStore.clear();
    saveCloudSession({ userId: "other", organizationId: "other-org", csrfToken: "other" });
    await act(async () => persisted());
    expect(h.call).not.toHaveBeenCalled();
    expect(pendingMessageStore.memory.size).toBe(0);
  });
});
