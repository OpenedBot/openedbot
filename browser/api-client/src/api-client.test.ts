import { describe, expect, test } from "bun:test";
import { ApiClient, ApiClientError, parseEventStream, type StreamGap } from "./api-client";

function sseBody(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

const gapFrame = 'event: stream.gap\ndata: {"organizationId":"org-1","from":7,"to":9800}\n\n';
const eventFrame = (cursor: number) =>
  `id: ${cursor}\nevent: run.completed\ndata: ${JSON.stringify({
    cursor, organizationId: "org-1", threadId: "thread-1", runId: "run-1", sequence: 0,
    type: "run.completed", payload: {}, occurredAt: "2026-08-25T00:00:00.000Z",
  })}\n\n`;

describe("parseEventStream", () => {
  test("rend chaque trame avec son nom ; commentaires et heartbeats sont ignorés", async () => {
    const frames = [];
    for await (const frame of parseEventStream(sseBody(`: connected\n\n${gapFrame}${eventFrame(9_801)}: heartbeat 1\n\n`))) {
      frames.push(frame);
    }
    expect(frames.map((frame) => frame.event)).toEqual(["stream.gap", "run.completed"]);
    expect(frames[0]!.data).toEqual({ organizationId: "org-1", from: 7, to: 9_800 });
    expect((frames[1]!.data as { cursor: number }).cursor).toBe(9_801);
  });
});

describe("ApiClient.events", () => {
  test("the selected mandate travels on SSE and a revocation stops it without reconnecting", async () => {
    const errors: unknown[] = [];
    const calls: Headers[] = [];
    const client = new ApiClient({
      baseUrl: "http://api.test", organizationId: () => "org-1", actingFleetId: () => "agency-a",
      fetch: async (_input, init) => {
        calls.push(new Headers(init?.headers));
        return new Response(sseBody(`${eventFrame(8)}event: stream.revoked\ndata: {"organizationId":"org-1","code":"WORKSPACE_ACCESS_REVOKED"}\n\n`), {
          status: 200, headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    const cursors: number[] = [];
    for await (const event of client.events({ cursor: 7, signal: new AbortController().signal, onError: (error) => errors.push(error) })) {
      if (event.cursor !== undefined) cursors.push(event.cursor);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.get("X-OHB-Organization")).toBe("org-1");
    expect(calls[0]!.get("X-OHB-Fleet")).toBe("agency-a");
    expect(cursors).toEqual([8]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ApiClientError);
    expect(errors[0]).toMatchObject({ status: 403, code: "WORKSPACE_ACCESS_REVOKED" });
  });
  test("stream.gap déclenche onGap sans avancer le curseur ni sortir comme événement", async () => {
    const controller = new AbortController();
    const requested: string[] = [];
    const client = new ApiClient({
      baseUrl: "http://api.test",
      organizationId: () => "org-1",
      fetch: async (input) => {
        requested.push(input);
        return new Response(sseBody(`${gapFrame}${eventFrame(9_801)}`), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    const gaps: StreamGap[] = [];
    const cursors: number[] = [];
    for await (const event of client.events({
      cursor: 7,
      signal: controller.signal,
      onGap: (gap) => gaps.push(gap),
      onError: () => controller.abort(),
    })) {
      if (event.cursor !== undefined) cursors.push(event.cursor);
      controller.abort();
    }
    expect(requested[0]).toContain("/api/events?cursor=7");
    expect(gaps).toEqual([{ organizationId: "org-1", from: 7, to: 9_800 }]);
    expect(cursors).toEqual([9_801]);
  });

  test("threadIds filtre côté serveur ; stream.cursor avance la reprise sans sortir comme événement", async () => {
    const controller = new AbortController();
    const requested: string[] = [];
    const bodies = [
      `${eventFrame(10)}id: 42\nevent: stream.cursor\ndata: {"organizationId":"org-1","cursor":42}\n\n`,
      eventFrame(43),
    ];
    const client = new ApiClient({
      baseUrl: "http://api.test",
      organizationId: () => "org-1",
      fetch: async (input) => {
        requested.push(input);
        return new Response(sseBody(bodies.shift() ?? ""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const advanced: number[] = [];
    const cursors: number[] = [];
    for await (const event of client.events({
      cursor: 7,
      threadIds: ["thread-a", "thread b"],
      signal: controller.signal,
      onCursor: (cursor) => advanced.push(cursor),
    })) {
      if (event.cursor !== undefined) cursors.push(event.cursor);
      if (cursors.length === 2) controller.abort();
    }
    expect(requested).toEqual([
      "http://api.test/api/events?cursor=7&threadId=thread-a&threadId=thread%20b",
      "http://api.test/api/events?cursor=42&threadId=thread-a&threadId=thread%20b",
    ]);
    expect(advanced).toEqual([42]);
    expect(cursors).toEqual([10, 43]);
  });

  test("un trou slow_consumer garde sa raison, reprend au dernier événement, et ne retente pas à 500 ms", async () => {
    const controller = new AbortController();
    const requested: string[] = [];
    const delays: number[] = [];
    const errors: unknown[] = [];
    const bodies = [
      `${eventFrame(11)}event: stream.gap\ndata: {"organizationId":"org-1","from":11,"to":12,"reason":"slow_consumer"}\n\n`,
      eventFrame(12),
    ];
    const client = new ApiClient({
      baseUrl: "http://api.test",
      organizationId: () => "org-1",
      fetch: async (input) => {
        requested.push(input);
        return new Response(sseBody(bodies.shift() ?? ""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (typeof timeout === "number" && timeout > 0) delays.push(timeout);
      return original(handler, 0, ...args);
    }) as typeof setTimeout;
    const gaps: StreamGap[] = [];
    const cursors: number[] = [];
    try {
      for await (const event of client.events({
        cursor: 10,
        signal: controller.signal,
        onGap: (gap) => gaps.push(gap),
        onError: (error) => errors.push(error),
      })) {
        if (event.cursor !== undefined) cursors.push(event.cursor);
        if (cursors.length === 2) controller.abort();
      }
    } finally {
      globalThis.setTimeout = original;
    }
    expect(gaps).toEqual([{ organizationId: "org-1", from: 11, to: 12, reason: "slow_consumer" }]);
    expect(requested.map((url) => new URL(url).searchParams.get("cursor"))).toEqual(["10", "11"]);
    expect(cursors).toEqual([11, 12]);
    expect(errors).toEqual([]);
    expect(delays[0]).toBeGreaterThanOrEqual(5_000);
  });

  test("une trame sans curseur est livrée et la reprise reste au dernier curseur durable", async () => {
    const controller = new AbortController();
    const requested: string[] = [];
    const live = `event: agent.message\ndata: ${JSON.stringify({
      organizationId: "org-1", threadId: "thread-1", runId: "run-1", sequence: 3,
      type: "agent.message", payload: { delta: "a" }, occurredAt: "2026-10-03T12:00:00.000Z",
    })}\n\n`;
    const bodies = [live, eventFrame(8)];
    const client = new ApiClient({
      baseUrl: "http://api.test",
      organizationId: () => "org-1",
      fetch: async (input) => {
        requested.push(input);
        return new Response(sseBody(bodies.shift() ?? ""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      return original(handler, 0, ...args);
    }) as typeof setTimeout;
    const cursors: Array<number | undefined> = [];
    try {
      for await (const event of client.events({
        cursor: 7,
        signal: controller.signal,
        onError: () => undefined,
      })) {
        cursors.push(event.cursor);
        if (cursors.length === 2) controller.abort();
      }
    } finally {
      globalThis.setTimeout = original;
    }
    expect(cursors).toEqual([undefined, 8]);
    expect(requested.map((url) => new URL(url).searchParams.get("cursor"))).toEqual(["7", "7"]);
  });
});
