import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import { logger } from "@openedbot/platform-observability";
import {
  SSE_MAX_PENDING_EVENTS,
  SSE_MAX_QUEUED_BYTES,
  sseSlowConsumerClosures,
} from "../src/interfaces/http/event-routes";
import { frameReader, sseTestApp, storedRow, streamEvent } from "./fixtures/event-stream";
import { fakeRunEventsDb } from "./fixtures/run-events-db";


const delta = "x".repeat(2_000);
const liveEvent = (organizationId: string, cursor: number) => streamEvent(organizationId, cursor, "thread-1", delta);
const row = (organizationId: string, cursor: number) => storedRow(organizationId, cursor, "thread-1", delta);

/** Le flux s'arme (souscription, rejeu, poller) avant le premier événement live. */
const armed = () => Bun.sleep(20);

const warnings: unknown[] = [];
const warn = spyOn(logger, "warn").mockImplementation(((entry: unknown) => { warnings.push(entry); }) as never);
afterEach(() => {
  warnings.length = 0;
  warn.mockClear();
});
afterAll(() => warn.mockRestore());

describe("flux SSE borné : lecteur lent", () => {
  test("un lecteur qui ne lit plus reçoit stream.gap puis la fin du flux, sans croissance au-delà du plafond", async () => {
    const organizationId = "org-slow-reader";
    const hub = new EventHub();
    const response = await sseTestApp(organizationId, fakeRunEventsDb([]), hub).request("http://localhost/?cursor=0");
    await armed();
    const closuresBefore = sseSlowConsumerClosures();

    // Le lecteur ne lit pas : 2 000 trames de ~2 Ko, soit ~4 Mo, bien au-delà du plafond.
    for (let cursor = 1; cursor <= 2_000; cursor += 1) hub.publish(liveEvent(organizationId, cursor));

    // Coupé dès le dépassement : plus d'abonné, la suite ne s'accumule nulle part.
    expect(hub.subscriberCount()).toBe(0);
    expect(sseSlowConsumerClosures()).toBe(closuresBefore + 1);

    const { frames, done } = await frameReader(response.body!).next();
    expect(done).toBe(true);
    const events = frames.filter((frame) => frame.event === "agent.message");
    const gap = frames.at(-1)!;
    expect(gap.event).toBe("stream.gap");
    expect(gap.id).toBeNull();
    const last = Number(events.at(-1)!.id);
    expect(JSON.parse(gap.data)).toEqual({ organizationId, from: last, to: last + 1, reason: "slow_consumer" });
    expect(events.map((frame) => Number(frame.id))).toEqual(Array.from({ length: last }, (_, index) => index + 1));

    const queued = events.reduce((total, frame) => total + frame.bytes, 0);
    expect(queued).toBeLessThanOrEqual(SSE_MAX_QUEUED_BYTES);
    expect(queued + events[0]!.bytes).toBeGreaterThan(SSE_MAX_QUEUED_BYTES - 100);

    expect(warnings).toEqual([expect.objectContaining({
      event: "sse.slow_consumer_closed", organizationId, reason: "queue_bytes", from: last, to: last + 1,
    })]);
    const entry = warnings[0] as Record<string, unknown>;
    expect(entry.queuedBytes as number).toBeGreaterThan(SSE_MAX_QUEUED_BYTES - 3_000);
    expect(JSON.stringify(entry)).not.toContain(delta);
  });

  test("un lecteur qui suit n'est jamais coupé, même au-delà du plafond en volume total", async () => {
    const organizationId = "org-healthy-reader";
    const hub = new EventHub();
    const response = await sseTestApp(organizationId, fakeRunEventsDb([]), hub).request("http://localhost/?cursor=0");
    await armed();
    const reader = frameReader(response.body!);
    const received: number[] = [];
    for (let batch = 0; batch < 20; batch += 1) {
      for (let index = 1; index <= 100; index += 1) hub.publish(liveEvent(organizationId, batch * 100 + index));
      const { frames } = await reader.next(100);
      received.push(...frames.map((frame) => Number(frame.id)));
    }
    await reader.cancel();

    expect(received).toEqual(Array.from({ length: 2_000 }, (_, index) => index + 1));
    expect(warnings).toEqual([]);
  });
});

describe("flux SSE borné : rejeu", () => {
  test("le live tenu pendant un rejeu lent est plafonné : stream.gap puis fin, et le rejeu s'arrête", async () => {
    const organizationId = "org-replay-buffer";
    const hub = new EventHub();
    let releaseReplay!: () => void;
    const replayHeld = new Promise<void>((resolve) => { releaseReplay = resolve; });
    const replayPages: number[] = [];
    const db = fakeRunEventsDb([2, 3, 4, 5].map((cursor) => row(organizationId, cursor)), {
      onReplayPage: (after) => {
        replayPages.push(after);
        return replayHeld;
      },
    });
    const response = await sseTestApp(organizationId, db, hub).request("http://localhost/?cursor=2");
    await armed();
    expect(replayPages).toEqual([2]);

    for (let cursor = 6; cursor < 6 + SSE_MAX_PENDING_EVENTS + 50; cursor += 1) hub.publish(liveEvent(organizationId, cursor));
    expect(hub.subscriberCount()).toBe(0);

    releaseReplay();
    const { frames, done } = await frameReader(response.body!).next();
    expect(done).toBe(true);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe("stream.gap");
    expect(JSON.parse(frames[0]!.data)).toEqual({
      organizationId, from: 2, to: 6 + SSE_MAX_PENDING_EVENTS, reason: "slow_consumer",
    });
    expect(replayPages).toEqual([2]);
    expect(warnings).toEqual([expect.objectContaining({
      event: "sse.slow_consumer_closed", organizationId, reason: "replay_buffer", pendingEvents: SSE_MAX_PENDING_EVENTS,
    })]);
  });

  test("un rejeu plus gros que le plafond suit le lecteur au lieu de remplir la file, et arrive entier", async () => {
    const organizationId = "org-paced-replay";
    const hub = new EventHub();
    const rows = Array.from({ length: 3_000 }, (_, index) => row(organizationId, index + 1));
    const replayPages: number[] = [];
    const db = fakeRunEventsDb(rows, { onReplayPage: (after) => { replayPages.push(after); } });
    const response = await sseTestApp(organizationId, db, hub, 5_000).request("http://localhost/?cursor=0");

    // Personne ne lit : le rejeu (~6 Mo) s'arrête au seuil de la file au lieu
    // d'aller au bout, donc le poller (page après le max capturé) n'est pas armé.
    await Bun.sleep(50);
    expect(replayPages).toEqual([0]);

    const reader = frameReader(response.body!);
    const { frames, done } = await reader.next(3_000);
    expect(done).toBe(false);
    expect(frames.map((frame) => Number(frame.id))).toEqual(rows.map((row) => Number(row.cursor)));
    await armed();
    expect(replayPages).toEqual([0, 3_000]);
    await reader.cancel();
    expect(warnings).toEqual([]);
  });
});
