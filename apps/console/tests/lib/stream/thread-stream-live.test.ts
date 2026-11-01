import { describe, expect, test } from "bun:test";
import type { ThreadSnapshot } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { eventStreamRetryDelay } from "@openedbot/browser-api-client";
import { applyProductEventToSnapshot } from "@openedbot/conversation/domain/thread-snapshot-mutations";
import {
  acceptLiveEvent,
  advanceStreamCursor,
  createLiveDedupe,
  refetchOnStreamOpen,
  refreshAfterAppliedEvent,
} from "../../../src/lib/stream/thread-stream-live";

function event(overrides: Partial<StoredProductEvent> & Pick<StoredProductEvent, "cursor" | "runId" | "sequence">): StoredProductEvent {
  return {
    type: "agent.message",
    payload: { text: "x" },
    occurredAt: new Date("2026-08-25T00:00:00.000Z"),
    ...overrides,
  } as StoredProductEvent;
}

describe("flux live", () => {
  test("un doublon (runId, sequence) n'est pas relivré, le curseur durable avance", () => {
    const state = createLiveDedupe();
    const first = acceptLiveEvent(
      state,
      { organizationId: "org-1", cursor: 10, runId: "run-1", sequence: 1 },
      "org-1",
      0,
    );
    const replay = acceptLiveEvent(
      state,
      { organizationId: "org-1", cursor: 11, runId: "run-1", sequence: 1 },
      "org-1",
      first.streamCursor,
    );
    expect(first).toEqual({ deliver: true, streamCursor: 10 });
    expect(replay).toEqual({ deliver: false, streamCursor: 11 });
  });

  test("un fan-out sans curseur puis le rejeu durable ne double pas la bulle", () => {
    const state = createLiveDedupe();
    const live = acceptLiveEvent(
      state,
      { organizationId: "org-1", runId: "run-1", sequence: 4 },
      "org-1",
      7,
    );
    const replay = acceptLiveEvent(
      state,
      { organizationId: "org-1", cursor: 12, runId: "run-1", sequence: 4 },
      "org-1",
      live.streamCursor,
    );
    expect(live).toEqual({ deliver: true, streamCursor: 7 });
    expect(replay).toEqual({ deliver: false, streamCursor: 12 });
  });

  test("stream.cursor avance le curseur sans événement de fil", () => {
    expect(advanceStreamCursor(4, 42)).toBe(42);
    expect(advanceStreamCursor(42, 7)).toBe(42);
    expect(advanceStreamCursor(42, Number.NaN)).toBe(42);
  });

  test("un slow_consumer ne retente pas à 500 ms", () => {
    expect(eventStreamRetryDelay(1)).toBe(500);
    expect(eventStreamRetryDelay(1, "slow_consumer")).toBeGreaterThanOrEqual(5_000);
    expect(eventStreamRetryDelay(1, "slow_consumer")).toBeGreaterThan(eventStreamRetryDelay(1));
  });

  test("une reconnexion dans la fenêtre ne relit pas le fil", () => {
    expect(refetchOnStreamOpen(false)).toEqual({ thread: false, roster: false });
    expect(refetchOnStreamOpen(true)).toEqual({ thread: true, roster: true });
  });

  test("un delta de run connu se patche ; un run encore absent après le patch se relit", () => {
    const delta = event({ cursor: 5, runId: "run-1", sequence: 2 });
    expect(refreshAfterAppliedEvent({
      event: delta,
      hadSnapshot: true,
      snapshotAfter: { runs: [{ id: "run-1" }] },
      snapshotCursorBefore: 4,
    })).toEqual({ thread: false, roster: false });
    expect(refreshAfterAppliedEvent({
      event: delta,
      hadSnapshot: true,
      snapshotAfter: { runs: [] },
      snapshotCursorBefore: 4,
    })).toEqual({ thread: true, roster: true });
  });

  test("le préfixe copié par le snapshot garde l'identité des événements", () => {
    const first = event({ cursor: 1, runId: "run-1", sequence: 1, payload: { text: "a" } });
    const snapshot = {
      id: "thread-1",
      cursor: 1,
      events: [first],
      runs: [{ id: "run-1", status: "running", error: null, startedAt: "2026-08-25T00:00:00.000Z" }],
      messages: [],
    } as unknown as ThreadSnapshot;
    const delta = event({ cursor: 2, runId: "run-1", sequence: 2, payload: { text: "b" } });
    const next = applyProductEventToSnapshot(snapshot, delta);
    expect(next.events[0]).toBe(first);
    expect(next.events.at(-1)).toBe(delta);
    expect(next.events).not.toBe(snapshot.events);
    expect(applyProductEventToSnapshot(next, { ...delta })).toBe(next);
  });
});
