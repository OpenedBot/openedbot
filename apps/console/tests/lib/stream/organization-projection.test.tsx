import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { BotDto, RosterDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { ReactNode } from "react";
import { api, queryKeys, type ThreadView } from "../../../src/lib/api";
import { clearCloudSession, saveCloudSession } from "../../../src/lib/session/cloud-session";
import { queryClient } from "../../../src/lib/query-client";
import { OrganizationStreamProjection } from "../../../src/lib/stream/organization-projection";
import { setOpenThread, shellProjectionActive, stopOrganizationStream } from "../../../src/lib/stream/organization-stream";
import { useThreadStream } from "../../../src/lib/stream/use-thread-stream";

/**
 * Rework-flux-api step 4: the shell holds the organization stream while the
 * window is visible and projects it onto the roster, the inbox and the
 * memories; the open thread only does when the shell does not.
 */
const organizationId = "org-shell-stream";

type OpenStream = { cursor: string | null; controller: ReadableStreamDefaultController<Uint8Array> };

function bot(id: string, threadId: string): BotDto {
  return {
    id, threadId, name: id, slug: id, description: null, instructions: "", model: null, reasoningEffort: null,
    sectionId: "section-1", position: 0, pinned: false, face: null, voiceId: null, hermesProfile: null,
    isolation: "shared" as BotDto["isolation"], hasOwnRuntime: false, runtimeName: null, awaitingApproval: false,
    running: true, unread: false, preview: null, archivedAt: null, createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z", lastRunAt: null, lastActivityAt: "2026-11-07T00:00:00.000Z",
  } as BotDto;
}

const roster = (): RosterDto => ({ sections: [], bots: [bot("bot-b", "thread-b")], groups: [], cursor: 4 });

function completed(cursor: number, threadId: string): StoredProductEvent {
  return {
    cursor, organizationId, threadId, runId: `run-${cursor}`, sequence: 9, type: "run.completed",
    payload: {}, occurredAt: "2026-11-07T10:00:00.000Z",
  } as unknown as StoredProductEvent;
}

function sseFrame(event: StoredProductEvent): Uint8Array {
  return new TextEncoder().encode(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

let realFetch: typeof globalThis.fetch;
let streams: OpenStream[];
let restores: Array<() => void>;
let invalidations: string[];
let visibility: DocumentVisibilityState;

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

beforeEach(() => {
  stopOrganizationStream();
  clearCloudSession();
  queryClient.clear();
  saveCloudSession({ organizationId, csrfToken: "shell-stream-csrf", userId: "shell-stream-user" });
  streams = [];
  restores = [];
  invalidations = [];
  visibility = "visible";
  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  restores.push(() => {
    Reflect.deleteProperty(document, "visibilityState");
    if (descriptor) Object.defineProperty(Document.prototype, "visibilityState", descriptor);
  });
  const invalidate = spyOn(queryClient, "invalidateQueries").mockImplementation((filters) => {
    invalidations.push(JSON.stringify(filters?.queryKey));
    return Promise.resolve();
  });
  const rosterFetch = spyOn(api, "roster").mockResolvedValue(roster());
  restores.push(() => invalidate.mockRestore(), () => rosterFetch.mockRestore());
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
    if (!url.pathname.endsWith("/api/events")) throw new Error(`Unexpected test fetch: ${url.pathname}`);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(next) { controller = next; } });
    const close = () => { try { controller.close(); } catch { /* already closed */ } };
    init?.signal?.addEventListener("abort", close, { once: true });
    if (init?.signal?.aborted) close();
    streams.push({ cursor: url.searchParams.get("cursor"), controller });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  cleanup();
  stopOrganizationStream();
  setOpenThread(undefined);
  for (const restore of restores) restore();
  queryClient.clear();
  clearCloudSession();
  globalThis.fetch = realFetch;
});

const rosterRow = () => queryClient.getQueryData<RosterDto>(queryKeys.roster)?.bots[0];
const invalidated = (key: readonly unknown[]) => invalidations.includes(JSON.stringify(key));

test("outside any conversation, the shell opens the stream at the roster cursor and projects it", async () => {
  queryClient.setQueryData(queryKeys.roster, roster());
  render(<OrganizationStreamProjection />, { wrapper });
  await waitFor(() => expect(streams).toHaveLength(1));
  expect(streams[0]!.cursor).toBe("4");
  expect(shellProjectionActive()).toBe(true);

  await act(async () => streams[0]!.controller.enqueue(sseFrame(completed(5, "thread-b"))));
  await waitFor(() => expect(rosterRow()?.unread).toBe(true));
  expect(rosterRow()?.running).toBe(false);
  expect(queryClient.getQueryData<RosterDto>(queryKeys.roster)?.cursor).toBe(5);
  await waitFor(() => expect(invalidated(queryKeys.inbox)).toBe(true));
  expect(invalidated(["organization", organizationId, "bot-memories"])).toBe(true);

  cleanup();
  expect(shellProjectionActive()).toBe(false);
});

test("the thread on screen is patched without being marked unread", async () => {
  queryClient.setQueryData(queryKeys.roster, roster());
  setOpenThread("thread-b");
  render(<OrganizationStreamProjection />, { wrapper });
  await waitFor(() => expect(streams).toHaveLength(1));
  await act(async () => streams[0]!.controller.enqueue(sseFrame(completed(5, "thread-b"))));
  await waitFor(() => expect(rosterRow()?.running).toBe(false));
  expect(rosterRow()?.unread).toBe(false);
});

test("a hidden window holds no stream; back in view, it reopens from the roster and rereads the runtime", async () => {
  queryClient.setQueryData(queryKeys.roster, roster());
  setVisibility("hidden");
  render(<OrganizationStreamProjection />, { wrapper });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(streams).toHaveLength(0);

  act(() => setVisibility("visible"));
  await waitFor(() => expect(streams).toHaveLength(1));
  expect(streams[0]!.cursor).toBe("4");
  act(() => setVisibility("hidden"));
  await waitFor(() => expect(shellProjectionActive()).toBe(false));
  invalidations = [];
  act(() => setVisibility("visible"));
  await waitFor(() => expect(streams).toHaveLength(2));
  // The runtime is not in the event log: a reopened stream rereads it.
  await waitFor(() => expect(invalidated(queryKeys.runtime)).toBe(true));
});

test("no roster cursor, no stream: replaying from zero would resend the whole history", async () => {
  queryClient.setQueryData(queryKeys.roster, { ...roster(), cursor: undefined });
  render(<OrganizationStreamProjection />, { wrapper });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(streams).toHaveLength(0);
});

test("with a conversation open, the shell projects and the thread keeps its own patch", async () => {
  const threadId = "thread-a";
  const snapshot = {
    id: threadId, botId: "bot-a", title: "Thread", botName: "Bot", instructions: "", model: "m", effectiveModel: "m",
    createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z", messages: [], runs: [], events: [],
    workflows: [], cursor: 4, organizationCursor: 4, truncated: false, approvals: [],
  } as unknown as ThreadView;
  const threadFetch = spyOn(api, "thread").mockResolvedValue(snapshot);
  restores.push(() => threadFetch.mockRestore());
  queryClient.setQueryData(queryKeys.thread(threadId), snapshot);
  queryClient.setQueryData(queryKeys.roster, roster());
  render(<OrganizationStreamProjection />, { wrapper });
  renderHook(() => useThreadStream(threadId), { wrapper });
  await waitFor(() => expect(streams).toHaveLength(1));

  const writes = spyOn(queryClient, "setQueryData");
  restores.push(() => writes.mockRestore());
  await act(async () => streams[0]!.controller.enqueue(sseFrame(completed(5, "thread-b"))));
  await waitFor(() => expect(rosterRow()?.unread).toBe(true));
  // One stream, one roster write for the event: the thread did not project it again.
  expect(streams).toHaveLength(1);
  const rosterWrites = writes.mock.calls.filter(([key]) => JSON.stringify(key) === JSON.stringify(queryKeys.roster));
  expect(rosterWrites).toHaveLength(1);
});

test("a stream kept running by a thread while hidden is ahead of the roster: the shell rereads on its return", async () => {
  const threadId = "thread-a";
  const snapshot = {
    id: threadId, botId: "bot-a", title: "Thread", botName: "Bot", instructions: "", model: "m", effectiveModel: "m",
    createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z", messages: [], runs: [], events: [],
    workflows: [], cursor: 4, organizationCursor: 4, truncated: false, approvals: [],
  } as unknown as ThreadView;
  const threadFetch = spyOn(api, "thread").mockResolvedValue(snapshot);
  restores.push(() => threadFetch.mockRestore());
  queryClient.setQueryData(queryKeys.thread(threadId), snapshot);
  queryClient.setQueryData(queryKeys.roster, roster());
  setVisibility("hidden");
  render(<OrganizationStreamProjection />, { wrapper });
  renderHook(() => useThreadStream(threadId), { wrapper });
  await waitFor(() => expect(streams).toHaveLength(1));
  expect(shellProjectionActive()).toBe(false);
  // Delivered while only the thread listens, for a thread the roster does not show.
  await act(async () => streams[0]!.controller.enqueue(sseFrame(completed(9, "thread-zz"))));
  await new Promise((resolve) => setTimeout(resolve, 250));
  invalidations = [];

  act(() => setVisibility("visible"));
  await waitFor(() => expect(shellProjectionActive()).toBe(true));
  await waitFor(() => expect(invalidated(queryKeys.roster)).toBe(true));
  expect(invalidated(queryKeys.inbox)).toBe(true);
  expect(streams).toHaveLength(1);
});

test("events still buffered when the workspace changes never reach the new workspace's roster", async () => {
  queryClient.setQueryData(queryKeys.roster, roster());
  const otherRosterKey = ["organization", "org-other", "roster"];
  queryClient.setQueryData(otherRosterKey, roster());
  // Frames never run: the event stays in the shell's buffer until the cleanup.
  const realFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  restores.push(() => { globalThis.requestAnimationFrame = realFrame; });
  render(<OrganizationStreamProjection />, { wrapper });
  await waitFor(() => expect(streams).toHaveLength(1));
  const receipt = {
    cursor: 100, organizationId, threadId: "thread-b", runId: "run-receipt", sequence: 1, type: "message.admitted",
    payload: { messageId: "message-1", sourceRunId: "run-receipt" }, occurredAt: "2026-11-07T10:00:00.000Z",
  } as unknown as StoredProductEvent;
  await act(async () => streams[0]!.controller.enqueue(sseFrame(receipt)));
  await new Promise((resolve) => setTimeout(resolve, 50));

  act(() => saveCloudSession({ organizationId: "org-other", csrfToken: "other-csrf", userId: "shell-stream-user" }));
  await waitFor(() => expect(queryClient.getQueryData<RosterDto>(otherRosterKey)?.cursor).toBe(4));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(queryClient.getQueryData<RosterDto>(otherRosterKey)?.cursor).toBe(4);
});

test("a runtime.changed frame rereads the runtime now, and is never a roster event", async () => {
  queryClient.setQueryData(queryKeys.roster, roster());
  render(<OrganizationStreamProjection />, { wrapper });
  await waitFor(() => expect(streams).toHaveLength(1));
  invalidations = [];
  const frame = 'event: runtime.changed\ndata: {"runtimeId":"rt-1","reason":"changed"}\n\n';
  await act(async () => streams[0]!.controller.enqueue(new TextEncoder().encode(frame)));
  await waitFor(() => expect(invalidated(queryKeys.runtimeConfiguration)).toBe(true));
  expect(invalidated(queryKeys.runtimeList)).toBe(true);
  expect(invalidated(queryKeys.inbox)).toBe(false);
  expect(queryClient.getQueryData<RosterDto>(queryKeys.roster)?.cursor).toBe(4);
});
