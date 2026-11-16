import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MessageReactionDto } from "@openedbot/contracts-api";
import type { MessageReactionEmoji } from "@openedbot/conversation/domain/message-reply";
import { queryKeys, type ThreadView } from "../../../src/lib/api";
import { saveCloudSession } from "../../../src/lib/session/cloud-session";
import { patchMessageReaction, sortReactions, withMyReaction } from "../../../src/lib/thread/message-reactions";
import { useMessageReactionToggle } from "../../../src/lib/thread/use-message-reaction-toggle";

const heart = { emoji: "❤️", count: 1, reactedByMe: true };

describe("reaction aggregate", () => {
  test("a member holds several emojis at once; adding one keeps the others", () => {
    expect(withMyReaction([heart], "👍", true)).toEqual([
      { emoji: "👍", count: 1, reactedByMe: true },
      heart,
    ]);
  });

  test("removing the member's reaction keeps the others' count, drops an empty chip", () => {
    expect(withMyReaction([{ emoji: "🎉", count: 3, reactedByMe: true }], "🎉", false))
      .toEqual([{ emoji: "🎉", count: 2, reactedByMe: false }]);
    expect(withMyReaction([heart, { emoji: "👍", count: 1, reactedByMe: true }], "👍", false)).toEqual([heart]);
  });

  test("an aggregate already in the wanted state is returned as is", () => {
    const reactions = [heart];
    expect(withMyReaction(reactions, "❤️", true)).toBe(reactions);
    expect(withMyReaction(reactions, "👍", false)).toBe(reactions);
  });

  test("palette order, whatever the server's order", () => {
    expect(sortReactions([{ emoji: "👎", count: 1, reactedByMe: false }, heart, { emoji: "👍", count: 2, reactedByMe: false }])
      .map((reaction) => reaction.emoji)).toEqual(["👍", "❤️", "👎"]);
  });

  test("patching an unknown message leaves the snapshot untouched", () => {
    const view = snapshot([heart]);
    expect(patchMessageReaction(view, "other", "👍", true)).toBe(view);
  });
});

function snapshot(reactions: MessageReactionDto[]): ThreadView {
  return {
    id: "thread-1",
    cursor: 10,
    messages: [{ id: "msg-1", role: "assistant", content: [{ type: "text", text: "Quel test ?" }], runId: null, createdAt: "2026-11-16T15:45:00Z", reactions }],
    runs: [],
    events: [],
    approvals: [],
  } as unknown as ThreadView;
}

type Call = { method: "add" | "remove"; emoji: string; settle: (error?: Error) => void };

function harness(initial: MessageReactionDto[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const key = queryKeys.thread("thread-1");
  client.setQueryData(key, snapshot(initial));
  const calls: Call[] = [];
  const request = (method: Call["method"]) => (_thread: string, _message: string, emoji: MessageReactionEmoji) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ method, emoji, settle: (error) => error ? reject(error) : resolve() });
    });
  const requests = { add: request("add"), remove: request("remove") };
  const hook = renderHook(() => useMessageReactionToggle("thread-1", requests), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  const reactions = () => client.getQueryData<ThreadView>(key)!.messages[0]!.reactions;
  return { toggle: hook.result.current, calls, reactions };
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => saveCloudSession({ userId: "user-1", organizationId: "org-1", csrfToken: "csrf" }));
afterEach(() => cleanup());

describe("useMessageReactionToggle", () => {
  test("applies the toggle before the server answers", async () => {
    const h = harness([heart]);
    let done!: Promise<void>;
    await act(async () => { done = h.toggle("msg-1", "👍", false); });
    await flush();
    expect(h.reactions()).toEqual([{ emoji: "👍", count: 1, reactedByMe: true }, heart]);
    expect(h.calls.map((call) => `${call.method} ${call.emoji}`)).toEqual(["add 👍"]);
    h.calls[0]!.settle();
    await act(async () => { await done; });
    expect(h.reactions()).toEqual([{ emoji: "👍", count: 1, reactedByMe: true }, heart]);
  });

  test("a failed request reverts its own toggle and rejects", async () => {
    const h = harness([heart, { emoji: "👍", count: 1, reactedByMe: true }]);
    let outcome!: Promise<unknown>;
    await act(async () => { outcome = h.toggle("msg-1", "👍", true).then(() => "ok", (error: Error) => error.message); });
    await flush();
    expect(h.reactions()).toEqual([heart]);
    expect(h.calls[0]!.method).toBe("remove");
    h.calls[0]!.settle(new Error("offline"));
    expect(await outcome).toBe("offline");
    expect(h.reactions()).toEqual([{ emoji: "👍", count: 1, reactedByMe: true }, heart]);
  });

  test("a double click toggles twice and the requests reach the server in order", async () => {
    const h = harness([heart]);
    let first!: Promise<void>;
    let second!: Promise<void>;
    // Both clicks read the same stale button state (`active: false`).
    await act(async () => {
      first = h.toggle("msg-1", "👍", false);
      second = h.toggle("msg-1", "👍", false);
    });
    await flush();
    expect(h.reactions()).toEqual([heart]);
    // The DELETE waits for the PUT: it cannot overtake it on the network.
    expect(h.calls.map((call) => `${call.method} ${call.emoji}`)).toEqual(["add 👍"]);
    h.calls[0]!.settle();
    await flush();
    expect(h.calls.map((call) => `${call.method} ${call.emoji}`)).toEqual(["add 👍", "remove 👍"]);
    h.calls[1]!.settle();
    await act(async () => { await Promise.all([first, second]); });
    expect(h.reactions()).toEqual([heart]);
  });

  test("a failure that a later toggle already superseded does not revert it", async () => {
    const h = harness([heart]);
    let first!: Promise<unknown>;
    let second!: Promise<void>;
    await act(async () => {
      first = h.toggle("msg-1", "👍", false).catch(() => "failed");
      second = h.toggle("msg-1", "👍", true);
    });
    await flush();
    h.calls[0]!.settle(new Error("offline"));
    expect(await first).toBe("failed");
    await flush();
    // The second toggle (remove) already put the state the member wants.
    expect(h.reactions()).toEqual([heart]);
    h.calls[1]!.settle();
    await act(async () => { await second; });
    expect(h.reactions()).toEqual([heart]);
  });
});
