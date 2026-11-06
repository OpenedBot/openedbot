import { describe, expect, test } from "bun:test";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import {
  canStartLiveText,
  createLiveRunText,
  createLiveTextHold,
  joinsLiveText,
  LIVE_TEXT_COMMIT_MS,
  lastRunSequence,
} from "../../../src/lib/stream/live-run-text";
import { LIVE_NARRATION_MAX } from "../../../src/lib/stream/live-answer";

const runId = "run-live";
let cursor = 100;

function event(type: string, sequence: number, payload: Record<string, unknown> = {}, run = runId): StoredProductEvent {
  return {
    cursor: cursor++,
    organizationId: "org",
    threadId: "thread",
    runId: run,
    sequence,
    type,
    payload,
    occurredAt: "2026-11-06T00:00:00.000Z",
  } as unknown as StoredProductEvent;
}

const text = (sequence: number, value: string, run = runId) => event("agent.message", sequence, { text: value }, run);
const LONG = "x".repeat(LIVE_NARRATION_MAX + 1);

describe("createLiveRunText", () => {
  test("gives the run's text after a sequence, up to the first break", () => {
    const store = createLiveRunText();
    store.record(text(1, "Un "));
    store.record(text(2, "deux "));
    store.record(event("tool.call", 3, { tool: "search" }));
    store.record(text(4, "après l'outil"));
    expect(store.textAfter(runId, 0)).toBe("Un deux ");
    expect(store.textAfter(runId, 1)).toBe("deux ");
    expect(store.textAfter(runId, 2)).toBe("");
    expect(store.textAfter(runId, 3)).toBe("après l'outil");
    expect(store.textAfter("other-run", 0)).toBe("");
  });

  test("ignores replays, lets renderless events through, and cuts at a notice or a MEDIA tag", () => {
    const store = createLiveRunText();
    store.record(text(1, "a"));
    store.record(text(1, "a"));
    store.record(event("tool.result", 2));
    store.record(text(3, "b"));
    expect(store.textAfter(runId, 0)).toBe("ab");
    store.record(event("system.notice", 4, { kind: "group.pass" }));
    store.record(text(5, "c"));
    expect(store.textAfter(runId, 0)).toBe("ab");
    expect(store.textAfter(runId, 4)).toBe("c");
    // The tag arrives in two fragments: the second one cuts.
    store.record(text(6, " ME"));
    store.record(text(7, "DIA:/workspace/x.png"));
    expect(store.textAfter(runId, 4)).toBe("c ME");
  });

  test("notifies a run's subscribers on publish only, and keeps a subscribed run when others pile up", () => {
    const store = createLiveRunText();
    let calls = 0;
    const unsubscribe = store.subscribe(runId, () => { calls += 1; });
    store.record(text(1, "a"));
    expect(calls).toBe(0);
    store.publish();
    expect(calls).toBe(1);
    store.publish();
    expect(calls).toBe(1);
    for (let index = 0; index < 8; index += 1) store.record(text(1, "other", `run-${index}`));
    expect(store.textAfter(runId, 0)).toBe("a");
    expect(store.textAfter("run-0", 0)).toBe("");
    expect(store.textAfter("run-7", 0)).toBe("other");
    unsubscribe();
  });
});

describe("canStartLiveText", () => {
  test("opens only on the confirmed answer that ends the thread", () => {
    const snapshot = [text(1, LONG)];
    expect(canStartLiveText(snapshot, text(2, "suite"))).toBe(true);
    // A narration line: the timeline may still move it into the work block.
    expect(canStartLiveText([text(1, "Je cherche.")], text(2, "suite"))).toBe(false);
    // The thread ends with another run, or with something else than text.
    expect(canStartLiveText([text(1, LONG), text(1, "autre", "run-other")], text(2, "suite"))).toBe(false);
    expect(canStartLiveText([text(1, LONG), event("tool.call", 2)], text(3, "suite"))).toBe(false);
  });

  test("reads the bubble's text across renderless events and other runs, and stops at its boundary", () => {
    const half = "y".repeat(Math.ceil(LIVE_NARRATION_MAX / 2) + 1);
    const across = [text(1, half), event("tool.result", 2), text(1, "z", "run-other"), text(3, half)];
    expect(canStartLiveText(across, text(4, "suite"))).toBe(true);
    const cut = [text(1, half), event("tool.call", 2), text(3, half)];
    expect(canStartLiveText(cut, text(4, "suite"))).toBe(false);
  });

  test("refuses a notice, an approval or a MEDIA tag in the bubble", () => {
    expect(canStartLiveText([event("system.notice", 1, { kind: "group.pass" }), text(2, LONG)], text(3, "s"))).toBe(false);
    expect(canStartLiveText([event("approval.requested", 1), text(2, LONG)], text(3, "s"))).toBe(false);
    expect(canStartLiveText([text(1, `${LONG}\nMEDIA:/workspace/a.png\n`)], text(2, "s"))).toBe(false);
    expect(canStartLiveText([text(1, `${LONG}\nMED`)], text(2, "IA:/workspace/a.png"))).toBe(false);
  });
});

describe("createLiveTextHold", () => {
  test("holds a confirmed answer's fragments until released, in order", () => {
    let now = 0;
    const hold = createLiveTextHold(() => now);
    const snapshot = { events: [text(1, LONG)] };
    expect(hold.dueIn(now)).toBeNull();
    expect(hold.offer(text(2, "a"), snapshot)).toBe(true);
    now = 400;
    expect(hold.offer(text(3, "b"), snapshot)).toBe(true);
    expect(hold.dueIn(now)).toBe(LIVE_TEXT_COMMIT_MS - 400);
    now = LIVE_TEXT_COMMIT_MS;
    expect(hold.dueIn(now)).toBe(0);
    expect(hold.release().map((held) => held.sequence)).toEqual([2, 3]);
    expect(hold.dueIn(now)).toBeNull();
  });

  test("refuses anything that would not extend the held text", () => {
    const hold = createLiveTextHold(() => 0);
    const snapshot = { events: [text(1, LONG)] };
    expect(hold.offer(event("tool.call", 2), snapshot)).toBe(false);
    expect(hold.offer(text(1, "replay"), snapshot)).toBe(false);
    expect(hold.offer(text(2, "a"), undefined)).toBe(false);
    expect(hold.offer(text(2, "a"), snapshot)).toBe(true);
    expect(hold.offer(text(1, "b", "run-other"), snapshot)).toBe(false);
    expect(hold.offer(text(3, "MEDIA:/workspace/a.png"), snapshot)).toBe(false);
    // A tag that starts in the snapshot and ends two fragments later.
    const split = createLiveTextHold(() => 0);
    const tagged = { events: [text(1, `${LONG}\nMED`)] };
    expect(split.offer(text(2, "I"), tagged)).toBe(true);
    expect(split.offer(text(3, "A:/workspace/a.png"), tagged)).toBe(false);
    // A snapshot read back from the server that already has the held text.
    expect(hold.offer(text(3, "c"), { events: [text(1, LONG), text(2, "a")] })).toBe(false);
  });
});

test("lastRunSequence reads the run's last event", () => {
  expect(lastRunSequence([text(1, "a"), text(4, "b"), text(9, "c", "run-other")], runId)).toBe(4);
  expect(lastRunSequence([], runId)).toBe(-1);
});

test("joinsLiveText refuses a MEDIA tag formed across the snapshot and the suffix", () => {
  expect(joinsLiveText("Voici :\nMED", "IA:/workspace/a.png")).toBe(false);
  expect(joinsLiveText("Voici :\nME", "D")).toBe(true);
  expect(joinsLiveText("Voici", " la suite")).toBe(true);
});
