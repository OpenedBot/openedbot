import { describe, expect, test } from "bun:test";
import {
  ApiClient,
  ApiClientError,
  EVENT_STREAM_IDLE_TIMEOUT_MS,
  nextStreamAttempt,
  parseEventStream,
  STABLE_STREAM_MS,
  type StreamGap,
} from "./api-client";

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

/** Un flux qui rend ces blocs, tels quels, puis reste ouvert ; `cancelled` dit s'il a été annulé. */
function openBody(...chunks: string[]): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

/** Les délais de reconnexion ramenés à zéro ; `delays` garde les durées demandées, hors délai d'inactivité. */
async function withInstantTimers<T>(run: (delays: number[]) => Promise<T>): Promise<T> {
  const delays: number[] = [];
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof timeout === "number" && timeout > 0 && timeout !== EVENT_STREAM_IDLE_TIMEOUT_MS) delays.push(timeout);
    return original(handler, 0, ...args);
  }) as typeof setTimeout;
  try {
    return await run(delays);
  } finally {
    globalThis.setTimeout = original;
  }
}

describe("parseEventStream, robustesse", () => {
  test("un CRLF coupé entre deux blocs délimite toujours la trame", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of ['data: {"n":1}\r', "\n\r", "\n"]) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const frames = [];
    for await (const frame of parseEventStream(body)) frames.push(frame.data);
    expect(frames).toEqual([{ n: 1 }]);
  });

  test("quitter l'itération avant la fin annule le flux sous-jacent", async () => {
    const source = openBody('data: {"n":1}\n\n');
    const generator = parseEventStream(source.body);
    expect((await generator.next()).value).toEqual({ event: null, data: { n: 1 } });
    await generator.return(undefined);
    expect(source.cancelled()).toBe(true);
  });

  test("une trame illisible remonte son erreur et annule le flux", async () => {
    const source = openBody("data: {pas du json\n\n");
    const generator = parseEventStream(source.body);
    await expect(generator.next()).rejects.toBeInstanceOf(SyntaxError);
    expect(source.cancelled()).toBe(true);
  });

  test("un flux silencieux expire avec EVENT_STREAM_IDLE et est annulé", async () => {
    const source = openBody();
    const generator = parseEventStream(source.body, { idleTimeoutMs: 20 });
    await expect(generator.next()).rejects.toMatchObject({ code: "EVENT_STREAM_IDLE" });
    expect(source.cancelled()).toBe(true);
  });

  test("chaque bloc reçu, commentaire compris, réarme le délai d'inactivité", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let beat = 0; beat < 4; beat += 1) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        }
        controller.enqueue(encoder.encode('data: {"n":2}\n\n'));
        controller.close();
      },
    });
    const frames = [];
    for await (const frame of parseEventStream(body, { idleTimeoutMs: 40 })) frames.push(frame.data);
    expect(frames).toEqual([{ n: 2 }]);
  });
});

describe("nextStreamAttempt", () => {
  test("monte tant que les connexions tombent vite, repart de 1 après une connexion stable", () => {
    expect(nextStreamAttempt(2, null, 1_000)).toBe(3);
    expect(nextStreamAttempt(2, 1_000, 1_000 + STABLE_STREAM_MS - 1)).toBe(3);
    expect(nextStreamAttempt(2, 1_000, 1_000 + STABLE_STREAM_MS)).toBe(1);
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
    expect(calls[0]!.get("X-OpenedBot-Organization")).toBe("org-1");
    expect(calls[0]!.get("X-OpenedBot-Fleet")).toBe("agency-a");
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

  test("des coupures slow_consumer successives allongent le repli (5, 10, 20 s)", async () => {
    const controller = new AbortController();
    const slow = (cursor: number) =>
      `${eventFrame(cursor)}event: stream.gap\ndata: {"organizationId":"org-1","from":${cursor},"to":${cursor + 1},"reason":"slow_consumer"}\n\n`;
    const bodies = [slow(11), slow(12), slow(13), eventFrame(14)];
    const client = new ApiClient({
      baseUrl: "http://api.test",
      organizationId: () => "org-1",
      fetch: async () => new Response(sseBody(bodies.shift() ?? ""), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    });
    const delays = await withInstantTimers(async (delays) => {
      for await (const event of client.events({ cursor: 10, signal: controller.signal, onError: () => undefined })) {
        if (event.cursor === 14) controller.abort();
      }
      return delays;
    });
    expect(delays).toEqual([5_000, 10_000, 20_000]);
  });

  test("une connexion muette est abandonnée puis reprise au dernier curseur", async () => {
    const controller = new AbortController();
    const requested: string[] = [];
    const errors: unknown[] = [];
    const first = openBody(eventFrame(8));
    const bodies = [first.body, openBody(eventFrame(9)).body];
    const client = new ApiClient({
      baseUrl: "http://api.test",
      organizationId: () => "org-1",
      fetch: async (input) => {
        requested.push(input);
        return new Response(bodies.shift() ?? sseBody(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const cursors: number[] = [];
    await withInstantTimers(async () => {
      for await (const event of client.events({
        cursor: 7,
        idleTimeoutMs: 20,
        signal: controller.signal,
        onError: (error) => errors.push(error),
      })) {
        if (event.cursor !== undefined) cursors.push(event.cursor);
        if (event.cursor === 9) controller.abort();
      }
    });
    expect(cursors).toEqual([8, 9]);
    expect(requested.map((url) => new URL(url).searchParams.get("cursor"))).toEqual(["7", "8"]);
    expect(errors[0]).toMatchObject({ code: "EVENT_STREAM_IDLE" });
    expect(first.cancelled()).toBe(true);
  });

  test("chaque attente de reconnexion retire son écouteur abort en expirant", async () => {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, ...rest: [EventListenerOrEventListenerObject, AddEventListenerOptions?]) => {
      if (type === "abort") added += 1;
      add(type, ...rest);
    }) as typeof controller.signal.addEventListener;
    controller.signal.removeEventListener = ((type: string, ...rest: [EventListenerOrEventListenerObject, EventListenerOptions?]) => {
      if (type === "abort") removed += 1;
      remove(type, ...rest);
    }) as typeof controller.signal.removeEventListener;
    let calls = 0;
    const client = new ApiClient({
      baseUrl: "http://api.test",
      organizationId: () => "org-1",
      fetch: async () => {
        calls += 1;
        if (calls <= 3) throw new TypeError("réseau coupé");
        return new Response(sseBody(eventFrame(8)), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      },
    });
    await withInstantTimers(async () => {
      for await (const _event of client.events({ cursor: 7, signal: controller.signal, onError: () => undefined })) {
        controller.abort();
      }
    });
    expect(added).toBe(3);
    expect(removed).toBe(3);
  });
});
