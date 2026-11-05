import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { RosterDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { ReactNode } from "react";
import { api, queryKeys, type ThreadView } from "../../../src/lib/api";
import { clearCloudSession, saveCloudSession } from "../../../src/lib/session/cloud-session";
import { queryClient } from "../../../src/lib/query-client";
import { stopOrganizationStream, useThreadStream } from "../../../src/lib/stream/use-thread-stream";

const organizationId = "org-stream-test";
const threadId = "thread-stream-test";
const runId = "run-stream-known";

type OpenStream = {
  cursor: string | null;
  controller: ReadableStreamDefaultController<Uint8Array>;
};

const runSnapshot = (): Awaited<ReturnType<typeof api.thread>> => ({
  id: threadId,
  botId: "bot-stream-test",
  title: "Thread",
  botName: "Bot",
  instructions: "",
  model: "test/model",
  effectiveModel: "test/model",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  messages: [],
  runs: [{
    id: runId,
    status: "running",
    botId: "bot-stream-test",
    input: "hello",
    output: null,
    usage: null,
    error: null,
    hermesResponseId: null,
    runtimeSession: null,
    createdAt: "2026-10-04T00:00:00.000Z",
    startedAt: "2026-10-04T00:00:00.000Z",
    endedAt: null,
    lastEventAt: null,
    workflowId: null,
  }],
  events: [],
  workflows: [],
  cursor: 4,
  organizationCursor: 4,
  truncated: false,
  approvals: [],
});

const emptyRoster: RosterDto = {
  sections: [],
  bots: [],
  groups: [],
  cursor: 4,
};

let realFetch: typeof globalThis.fetch;
let streams: OpenStream[];
let restoreSpies: Array<() => void>;

function RosterProbe() {
  useQuery({ queryKey: queryKeys.roster, queryFn: () => api.roster() });
  return null;
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <RosterProbe />
      {children}
    </QueryClientProvider>
  );
}

function sseFrame(event: StoredProductEvent): Uint8Array {
  return new TextEncoder().encode(
    `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

beforeEach(() => {
  stopOrganizationStream();
  clearCloudSession();
  queryClient.clear();
  window.history.replaceState(null, "", "/");
  saveCloudSession({ organizationId, csrfToken: "stream-test-csrf", userId: "stream-test-user" });
  streams = [];
  restoreSpies = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
    if (!url.pathname.endsWith("/api/events")) {
      throw new Error(`Unexpected test fetch: ${url.pathname}`);
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    });
    const close = () => {
      try { controller.close(); } catch { /* already closed */ }
    };
    init?.signal?.addEventListener("abort", close, { once: true });
    if (init?.signal?.aborted) close();
    streams.push({ cursor: url.searchParams.get("cursor"), controller });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  cleanup();
  stopOrganizationStream();
  for (const restore of restoreSpies) restore();
  queryClient.clear();
  clearCloudSession();
  window.history.replaceState(null, "", "/");
  globalThis.fetch = realFetch;
});

test("an older page arriving after SSE and a recent refetch retain live state and loaded history", async () => {
  const snapshot = runSnapshot();
  snapshot.history = { nextBefore: "older", hasMore: true, turnKeys: [`run:${runId}`] };
  let resolveOlder!: (page: ThreadView) => void;
  const olderResponse = new Promise<ThreadView>((resolve) => { resolveOlder = resolve; });
  let latest = snapshot;
  const threadFetch = spyOn(api, "thread").mockImplementation((_id, before) => before ? olderResponse : Promise.resolve(latest));
  const rosterFetch = spyOn(api, "roster").mockResolvedValue(emptyRoster);
  restoreSpies.push(() => threadFetch.mockRestore(), () => rosterFetch.mockRestore());
  queryClient.setQueryData(queryKeys.thread(threadId), snapshot);
  queryClient.setQueryData(queryKeys.roster, emptyRoster);
  const hook = renderHook(() => useThreadStream(threadId), { wrapper });
  await waitFor(() => expect(hook.result.current.streaming).toBe(true));
  let loaded!: Promise<boolean>;
  act(() => { loaded = hook.result.current.loadOlder(); });
  expect(hook.result.current.loadOlder()).toBe(loaded);
  await waitFor(() => expect(hook.result.current.loadingOlder).toBe(true));
  const event = { cursor: 5, organizationId, threadId, runId, sequence: 1, type: "agent.message", payload: { text: "Live delta" },
    occurredAt: new Date("2026-10-05T00:00:00Z") } as StoredProductEvent;
  act(() => { streams[0]!.controller.enqueue(sseFrame(event)); });
  await waitFor(() => expect(hook.result.current.thread.data?.cursor).toBe(5));
  const older = runSnapshot();
  older.cursor = 200;
  older.organizationCursor = 200;
  older.history = { nextBefore: null, hasMore: false, turnKeys: ["run:old"] };
  older.runs = [{ ...older.runs[0]!, id: "old", input: "Historical input", status: "completed" }];
  older.messages = [{ id: "old-message", role: "user", content: [{ type: "text", text: "Historical input" }], runId: "old", createdAt: "2026-10-03T00:00:00Z" }];
  await act(async () => { resolveOlder(older); expect(await loaded).toBe(true); });
  expect(hook.result.current.thread.data?.cursor).toBe(5);
  expect(hook.result.current.thread.data?.events.map((item) => [item.runId, item.sequence, item.payload])).toEqual([[runId, 1, { text: "Live delta" }]]);
  expect(hook.result.current.thread.data?.runs.map((run) => run.id).sort()).toEqual(["old", runId].sort());
  latest = { ...snapshot, cursor: 5, organizationCursor: 5, events: [event] };
  await act(async () => { await hook.result.current.thread.refetch(); });
  expect(hook.result.current.thread.data?.messages.some((message) => message.id === "old-message")).toBe(true);
  expect(hook.result.current.thread.data?.history?.nextBefore).toBeNull();
  expect(hook.result.current.thread.data?.events).toHaveLength(1);
});

test("known agent.message patches cache and reconnect resumes without thread or roster refetch", async () => {
  const snapshot = runSnapshot();
  const streamError = spyOn(console, "error").mockImplementation(() => {});
  const threadFetch = spyOn(api, "thread").mockResolvedValue(snapshot);
  const rosterFetch = spyOn(api, "roster").mockResolvedValue(emptyRoster);
  restoreSpies.push(
    () => streamError.mockRestore(),
    () => threadFetch.mockRestore(),
    () => rosterFetch.mockRestore(),
  );
  queryClient.setQueryData(queryKeys.thread(threadId), snapshot);
  queryClient.setQueryData(queryKeys.roster, emptyRoster);

  const hook = renderHook(() => useThreadStream(threadId), { wrapper });
  await waitFor(() => expect(streams).toHaveLength(1));
  await waitFor(() => expect(hook.result.current.streaming).toBe(true));
  expect(threadFetch).not.toHaveBeenCalled();
  expect(rosterFetch).not.toHaveBeenCalled();

  const event = {
    cursor: 5,
    organizationId,
    threadId,
    runId,
    sequence: 1,
    type: "agent.message",
    payload: { text: "The known run is streaming." },
    occurredAt: "2026-10-04T00:00:01.000Z",
  } as unknown as StoredProductEvent;
  await act(async () => {
    streams[0]!.controller.enqueue(sseFrame(event));
  });
  await waitFor(() => {
    const current = queryClient.getQueryData<ThreadView>(queryKeys.thread(threadId));
    expect(current?.cursor).toBe(5);
    expect(current?.events).toHaveLength(1);
    expect(current?.events[0]).toMatchObject({ runId, sequence: 1, type: "agent.message" });
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(threadFetch).not.toHaveBeenCalled();
  expect(rosterFetch).not.toHaveBeenCalled();

  await act(async () => streams[0]!.controller.close());
  await waitFor(() => expect(streams).toHaveLength(2), { timeout: 3_000 });
  await waitFor(() => expect(hook.result.current.streaming).toBe(true));
  expect(streams.map((stream) => stream.cursor)).toEqual(["4", "5"]);
  expect(streamError).toHaveBeenCalledTimes(1);

  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(threadFetch).not.toHaveBeenCalled();
  expect(rosterFetch).not.toHaveBeenCalled();
  expect(queryClient.getQueryData<ThreadView>(queryKeys.thread(threadId))?.events)
    .toHaveLength(1);
});

test("fresh receipts refresh the thread, ambiguous steering wakes inbox, and receipts skip the run HUD", async () => {
  const snapshot = runSnapshot();
  const streamError = spyOn(console, "error").mockImplementation(() => {});
  const threadFetch = spyOn(api, "thread").mockResolvedValue(snapshot);
  const rosterFetch = spyOn(api, "roster").mockResolvedValue(emptyRoster);
  const invalidations: unknown[] = [];
  const invalidate = spyOn(queryClient, "invalidateQueries").mockImplementation((filters) => {
    invalidations.push(filters?.queryKey);
    return Promise.resolve();
  });
  const hudEvents: string[] = [];
  const previousHud = Object.getOwnPropertyDescriptor(window, "__openedbotThreadPerf");
  Object.defineProperty(window, "__openedbotThreadPerf", {
    configurable: true,
    value: { recordRunEvent: (_id: string, type: string) => hudEvents.push(type) },
  });
  restoreSpies.push(
    () => streamError.mockRestore(),
    () => threadFetch.mockRestore(),
    () => rosterFetch.mockRestore(),
    () => invalidate.mockRestore(),
    () => {
      if (previousHud) Object.defineProperty(window, "__openedbotThreadPerf", previousHud);
      else Reflect.deleteProperty(window, "__openedbotThreadPerf");
    },
  );
  queryClient.setQueryData(queryKeys.thread(threadId), snapshot);
  queryClient.setQueryData(queryKeys.roster, emptyRoster);

  const hook = renderHook(() => useThreadStream(threadId), { wrapper });
  await waitFor(() => expect(streams).toHaveLength(1));
  await waitFor(() => expect(hook.result.current.streaming).toBe(true));

  const messageReceipt = {
    cursor: 5,
    organizationId,
    threadId,
    runId,
    sequence: 1,
    type: "message.admitted",
    payload: { messageId: "message-admitted", sourceRunId: runId },
    occurredAt: "2026-10-04T00:00:01.000Z",
  } as unknown as StoredProductEvent;
  await act(async () => streams[0]!.controller.enqueue(sseFrame(messageReceipt)));
  await waitFor(() => expect(invalidations).toContainEqual(queryKeys.thread(threadId)));

  const steeringReceipt = {
    cursor: 6,
    organizationId,
    threadId,
    runId,
    sequence: 2,
    type: "run.steering",
    payload: { status: "ambiguous", attemptId: "attempt-1", sourceRunId: runId, targetRunId: runId },
    occurredAt: "2026-10-04T00:00:02.000Z",
  } as unknown as StoredProductEvent;
  await act(async () => streams[0]!.controller.enqueue(sseFrame(steeringReceipt)));
  await waitFor(() => expect(invalidations).toContainEqual(queryKeys.inbox));

  const threadInvalidationCount = invalidations.filter(
    (key) => JSON.stringify(key) === JSON.stringify(queryKeys.thread(threadId)),
  ).length;
  const inboxInvalidationCount = invalidations.filter(
    (key) => JSON.stringify(key) === JSON.stringify(queryKeys.inbox),
  ).length;
  await act(async () => streams[0]!.controller.enqueue(sseFrame(steeringReceipt)));
  await new Promise((resolve) => setTimeout(resolve, 250));

  expect(invalidations.filter((key) => JSON.stringify(key) === JSON.stringify(queryKeys.thread(threadId)))
    .length).toBe(threadInvalidationCount);
  expect(invalidations.filter((key) => JSON.stringify(key) === JSON.stringify(queryKeys.inbox))
    .length).toBe(inboxInvalidationCount);
  expect(hudEvents).toEqual([]);
  expect(threadFetch).not.toHaveBeenCalled();
  expect(rosterFetch).not.toHaveBeenCalled();
  expect(queryClient.getQueryData<ThreadView>(queryKeys.thread(threadId))?.events.map((event) => event.type))
    .toEqual(["message.admitted", "run.steering"]);
});
