import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SendMessageAccepted } from "@openedbot/contracts-api";
import type { MessageAttachmentInput } from "@openedbot/conversation/domain/attachments";
import { api } from "../../../src/lib/api";
import { useThreadMessageSend } from "../../../src/lib/thread/use-thread-message-send";

type Draft = { input: string; attachments: MessageAttachmentInput[]; replyToId?: string | null };
const empty: Draft = { input: "", attachments: [] };
const accepted: SendMessageAccepted = { runId: "run", workflowId: "wf", status: "queued",
  message: { id: "persisted", role: "user", content: [{ type: "text", text: "Hello" }], runId: "run", createdAt: "2026-09-15T00:00:00Z" } };
const attachment: MessageAttachmentInput = { name: "next.txt", contentType: "text/plain", kind: "document", content: [{ type: "text", text: "next attachment" }] };
let restoreSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { cleanup(); restoreSpy?.mockRestore(); });

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
  }, { initialProps: { threadId: initial }, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  return { ...hook, resolve, reject, call };
}

describe("thread send owns only its submitted draft", () => {
  test("clears immediately, then preserves the next text, attachment and reply after 202", async () => {
    const h = harness();
    act(() => h.result.current.send.mutate(h.result.current.draft));
    expect(h.result.current.draft).toEqual(empty);
    await waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));
    const next = { input: "Next", attachments: [attachment], replyToId: "reply-next" };
    act(() => h.result.current.setDraft(next));
    await act(async () => h.resolve(accepted));
    await waitFor(() => expect(h.result.current.send.isSuccess).toBe(true));
    expect(h.result.current.draft).toEqual(next);
    expect(h.result.current.send.outgoing?.messageId).toBe("persisted");
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
});
