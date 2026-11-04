import { describe, expect, test } from "bun:test";
import { openSupportEventStream, supportBackoffMs } from "./support-stream";

describe("openSupportEventStream", () => {
  test("des 200 vides en boucle attendent un repli croissant au lieu de reconnecter en rafale", async () => {
    let calls = 0;
    const delays: number[] = [];
    const statuses: boolean[] = [];
    let stopped!: () => void;
    const done = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    openSupportEventStream({
      url: (cursor) => `http://api.test/events?cursor=${cursor}`,
      cursor: 0,
      onEvent: () => {},
      onStatus: (connected) => {
        statuses.push(connected);
        if (calls === 4 && !connected) stopped();
      },
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 4) return new Response(null, { status: 401 });
        return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }) as unknown as typeof fetch,
      wait: async (ms) => {
        delays.push(ms);
      },
    });
    await done;
    expect(calls).toBe(4);
    expect(delays).toEqual([supportBackoffMs(1), supportBackoffMs(2), supportBackoffMs(3)]);
    expect(statuses).toEqual([true, false, true, false, true, false, false]);
  });

  test("l'attente par défaut retire son écouteur abort en expirant", async () => {
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) =>
      original(handler, 0, ...args)) as typeof setTimeout;
    let added = 0;
    let removed = 0;
    const realAdd = AbortSignal.prototype.addEventListener;
    const realRemove = AbortSignal.prototype.removeEventListener;
    AbortSignal.prototype.addEventListener = function (this: AbortSignal, type: string, ...rest: [EventListenerOrEventListenerObject, AddEventListenerOptions?]) {
      if (type === "abort") added += 1;
      realAdd.call(this, type, ...rest);
    } as typeof AbortSignal.prototype.addEventListener;
    AbortSignal.prototype.removeEventListener = function (this: AbortSignal, type: string, ...rest: [EventListenerOrEventListenerObject, EventListenerOptions?]) {
      if (type === "abort") removed += 1;
      realRemove.call(this, type, ...rest);
    } as typeof AbortSignal.prototype.removeEventListener;
    try {
      let calls = 0;
      let stopped!: () => void;
      const done = new Promise<void>((resolve) => {
        stopped = resolve;
      });
      openSupportEventStream({
        url: () => "http://api.test/events",
        cursor: 0,
        onEvent: () => {},
        onStatus: (connected) => {
          if (calls === 3 && !connected) stopped();
        },
        fetchImpl: (async () => {
          calls += 1;
          if (calls === 3) return new Response(null, { status: 401 });
          throw new TypeError("réseau coupé");
        }) as unknown as typeof fetch,
      });
      await done;
    } finally {
      globalThis.setTimeout = original;
      AbortSignal.prototype.addEventListener = realAdd;
      AbortSignal.prototype.removeEventListener = realRemove;
    }
    expect(added).toBe(2);
    expect(removed).toBe(2);
  });
});
