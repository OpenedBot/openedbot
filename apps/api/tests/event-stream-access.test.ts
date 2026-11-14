import { expect, test } from "bun:test";
import { Hono } from "hono";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import type { Db } from "@openedbot/platform-db";
import { eventRoutes } from "../src/routes/events/event-routes";
import type { AppVariables } from "../src/routes/identity/auth";
import { frameReader, streamEvent } from "./fixtures/event-stream";
import { fakeRunEventsDb } from "./fixtures/run-events-db";

test("the 15-second access check closes a stream whose membership ended and discards buffered events on refusal", async () => {
  const organizationId = "90000000-0000-4000-8000-000000000001";
  const hub = new EventHub();
  const base = fakeRunEventsDb([]);
  let started!: () => void;
  const checking = new Promise<void>((resolve) => { started = resolve; });
  let finish!: (rows: unknown[]) => void;
  const verified = new Promise<unknown[]>((resolve) => { finish = resolve; });
  const db = { begin: async (callback: (tx: unknown) => unknown) => base.begin(async (tx) => {
    const query = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("select s.id from sessions")) return Promise.resolve([{ id: "session" }]);
      if (sql.includes("from workspace_access(")) { started(); return verified; }
      return tx(strings, ...values);
    };
    return callback(query);
  }) } as unknown as Db;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", { organizationId, role: "member", sessionId: "session",
      credentialHash: "fixture-hash", userId: "operator", kind: "web" });
    await next();
  });
  app.route("/", eventRoutes(db, hub, { fallbackPollMs: 60_000, replayWindowMs: 3_600_000, replayWindowEvents: 1_000 }));
  const realInterval = globalThis.setInterval;
  let tick: (() => void) | undefined;
  globalThis.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 15_000 && typeof handler === "function") {
      tick = () => handler(...args);
      return realInterval(() => {}, 60_000);
    }
    return realInterval(handler, delay, ...args);
  }) as typeof setInterval;
  let response: Response;
  try { response = await app.request("http://localhost/?cursor=0"); }
  finally { globalThis.setInterval = realInterval; }
  const reader = frameReader(response.body!);
  try {
    await Bun.sleep(20);
    expect(tick).toBeDefined();
    tick!();
    await checking;
    hub.publish(streamEvent(organizationId, 1, "thread-1", "buffered-after-check-start"));
    // The organization is alive but the membership is gone: no role, no stream.
    finish([{ role: null }]);
    const { frames, done } = await reader.next();
    expect(done).toBe(true);
    expect(frames).toEqual([expect.objectContaining({ event: "stream.revoked", id: null,
      data: JSON.stringify({ organizationId, code: "WORKSPACE_ACCESS_REVOKED" }) })]);
    expect(hub.subscriberCount()).toBe(0);
  } finally {
    finish([]);
    await reader.cancel();
  }
});
