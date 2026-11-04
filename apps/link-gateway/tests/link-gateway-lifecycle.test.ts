import { describe, expect, test } from "bun:test";
import { API_INSTANCE_DEAD_AFTER_MS } from "@openedbot/runtime-link/application/instances";
import { routingLease, ShutdownDeadlineError, stopPersistence } from "../src/lifecycle";

const never = () => new Promise<never>(() => undefined);

describe("routing lease", () => {
  test("fresh only after a successful heartbeat, and expired past the instance-dead window", async () => {
    let clock = 1_000_000;
    let failing = false;
    const lease = routingLease({
      heartbeat: async () => { if (failing) throw new Error("db down"); },
      stop: async () => undefined,
    }, () => clock);
    expect(lease.fresh()).toBe(false);
    await lease.heartbeat();
    expect(lease.fresh()).toBe(true);
    // SELECT 1 may still answer while every api_instances write fails.
    failing = true;
    clock += API_INSTANCE_DEAD_AFTER_MS - 1;
    await expect(lease.heartbeat()).rejects.toThrow("db down");
    expect(lease.fresh()).toBe(true);
    clock += 1;
    expect(lease.fresh()).toBe(false);
  });

  test("a heartbeat counts from its start, not from when the database answered", async () => {
    let clock = 0;
    const lease = routingLease({
      heartbeat: async () => { clock += API_INSTANCE_DEAD_AFTER_MS; },
      stop: async () => undefined,
    }, () => clock);
    await lease.heartbeat();
    expect(lease.fresh()).toBe(false);
  });
});

describe("bounded persistence shutdown", () => {
  test("a heartbeat stuck on an established query neither blocks the flush nor the registry stop", async () => {
    const calls: string[] = [];
    const started = Date.now();
    const stopped = stopPersistence({
      heartbeatWork: never(),
      flush: async () => { calls.push("flush"); },
      stopRegistry: async () => { calls.push("stop"); },
      stepTimeoutMs: 20,
    });
    await expect(stopped).rejects.toBeInstanceOf(ShutdownDeadlineError);
    expect(calls).toEqual(["flush", "stop"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a stuck registry stop is bounded too", async () => {
    await expect(stopPersistence({
      heartbeatWork: Promise.resolve(),
      flush: async () => undefined,
      stopRegistry: never,
      stepTimeoutMs: 20,
    })).rejects.toThrow("instance registry stop");
  });

  test("resolves when every step completes in time", async () => {
    await expect(stopPersistence({
      heartbeatWork: Promise.resolve(),
      flush: async () => undefined,
      stopRegistry: async () => undefined,
      stepTimeoutMs: 1_000,
    })).resolves.toBeUndefined();
  });
});
