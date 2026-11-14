import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createRunQueueNotifications, RUN_QUEUE_CHANNEL } from "../src/infrastructure/run-queue-notifications";

beforeEach(() => {
  spyOn(console, "info").mockImplementation(() => undefined);
  spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  (console.info as unknown as { mockRestore(): void }).mockRestore();
  (console.warn as unknown as { mockRestore(): void }).mockRestore();
});

describe("run queue LISTEN adapter", () => {
  test("initial subscribe, notifications and reconnect ACK all request durable catch-up", async () => {
    let received!: (payload: string) => void;
    let ready!: () => void;
    let listens = 0;
    let closes = 0;
    let wakes = 0;
    const listener = createRunQueueNotifications("fixture-private-url", { clientFactory: () => ({
      listen: async (channel, onnotify, onlisten) => {
        expect(channel).toBe(RUN_QUEUE_CHANNEL);
        listens++;
        received = onnotify; ready = onlisten!;
        return { unlisten: async () => undefined };
      },
      close: async () => { closes++; },
    }) });
    listener.start(() => { wakes++; });
    listener.start(() => { throw new Error("must not start twice"); });
    ready(); received(""); ready();
    expect(wakes).toBe(3);
    expect(listens).toBe(1);
    await listener.stop(); await listener.stop();
    ready(); received("");
    expect(wakes).toBe(3);
    expect(closes).toBe(1);
  });

  test("stop closes and waits for a subscription still connecting", async () => {
    let reject!: (error: Error) => void;
    let closes = 0;
    const listener = createRunQueueNotifications("fixture-private-url", { clientFactory: () => ({
      listen: () => new Promise((_resolve, failed) => { reject = failed; }),
      close: async () => { closes++; reject(new Error("connection closed")); },
    }) });
    listener.start(() => { throw new Error("stopped listener cannot wake"); });
    await listener.stop();
    expect(closes).toBeGreaterThanOrEqual(1);
    expect((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
  });

  test("an initial connection failure retries without blocking the claim loop", async () => {
    let attempts = 0;
    let wakes = 0;
    let ready!: () => void;
    const listener = createRunQueueNotifications("fixture-private-url", { retryMs: 5, clientFactory: () => ({
      listen: async (_channel, _onnotify, onlisten) => {
        if (++attempts === 1) throw new Error("connection refused");
        ready = onlisten!;
        return { unlisten: async () => undefined };
      },
      close: async () => undefined,
    }) });
    listener.start(() => { wakes++; });
    try {
      const deadline = performance.now() + 500;
      while (!ready && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(attempts).toBe(2);
      ready();
      expect(wakes).toBe(1);
    } finally { await listener.stop(); }
  });

  test("a failed LISTEN falls back to the queue probe until the ACK, which stops it", async () => {
    let signature = "0:";
    let probes = 0;
    let wakes = 0;
    let attempts = 0;
    let ready!: () => void;
    const listener = createRunQueueNotifications("fixture-private-url", {
      retryMs: 5,
      probeMs: 5,
      probe: async () => { probes++; return signature; },
      clientFactory: () => ({
        listen: async (_channel, _onnotify, onlisten) => {
          if (++attempts === 1) throw new Error("connection refused");
          await new Promise<void>((resolve) => setTimeout(resolve, 60));
          ready = onlisten!;
          return { unlisten: async () => undefined };
        },
        close: async () => undefined,
      }),
    });
    const until = async (condition: () => boolean) => {
      const deadline = performance.now() + 500;
      while (!condition()) {
        if (performance.now() > deadline) throw new Error("condition not met in time");
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    };
    listener.start(() => { wakes++; });
    try {
      await until(() => probes >= 3);
      expect(wakes).toBe(0); // An unchanged queue is not a hint.
      signature = "1:2026-10-06 10:00:00.000001+00";
      await until(() => wakes === 1);
      await until(() => ready !== undefined);
      ready();
      expect(wakes).toBe(2);
      const afterAck = probes;
      signature = "2:2026-10-06 10:00:00.000002+00";
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(probes).toBeLessThanOrEqual(afterAck + 1);
      expect(wakes).toBe(2); // Hints now come from LISTEN only.
    } finally { await listener.stop(); }
  });
});
