import { describe, expect, test } from "bun:test";
import {
  growTimelineWindow,
  prependTimelinePage,
  THREAD_LIVE_TURN_WINDOW,
  windowTimelineEntries,
} from "../../src/lib/thread-window";

function keys(items: readonly { key: string }[]): string[] {
  return items.map((item) => item.key);
}

describe("windowTimelineEntries", () => {
  test("a list longer than the window returns the trailing slice and hasOlder", () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({ key: `e${index}` }));
    const windowed = windowTimelineEntries(entries, 3);
    expect(keys(windowed.visible)).toEqual(["e5", "e6", "e7"]);
    expect(windowed.hasOlder).toBe(true);
    expect(windowed.hiddenTurns).toBe(5);
    expect(windowed.turnCount).toBe(8);
  });

  test("a list shorter than the window is returned unchanged", () => {
    const entries = [{ key: "a" }, { key: "b" }];
    const windowed = windowTimelineEntries(entries, THREAD_LIVE_TURN_WINDOW);
    expect(windowed.visible).toBe(entries);
    expect(windowed.hasOlder).toBe(false);
    expect(windowed.hiddenTurns).toBe(0);
  });

  test("user kind starts a turn so tools stay with the question", () => {
    const entries = [
      { key: "u1", kind: "user" },
      { key: "t1", kind: "tools" },
      { key: "a1", kind: "assistant" },
      { key: "u2", kind: "user" },
      { key: "a2", kind: "assistant" },
      { key: "u3", kind: "user" },
      { key: "a3", kind: "assistant" },
    ];
    const windowed = windowTimelineEntries(entries, 2);
    expect(keys(windowed.visible)).toEqual(["u2", "a2", "u3", "a3"]);
    expect(windowed.hasOlder).toBe(true);
    expect(windowed.hiddenTurns).toBe(1);
  });
});

describe("prependTimelinePage", () => {
  test("prepend of the previous page concatenates without dropping the previous last keys", () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({ key: `e${index}` }));
    const first = windowTimelineEntries(entries, 3);
    expect(keys(first.visible)).toEqual(["e7", "e8", "e9"]);
    const prepended = prependTimelinePage(entries, first.visible, 4);
    expect(keys(prepended.visible)).toEqual(["e3", "e4", "e5", "e6", "e7", "e8", "e9"]);
    const previousLast = first.visible.map((item) => item.key);
    expect(keys(prepended.visible).slice(-previousLast.length)).toEqual(previousLast);
  });

  test("growTimelineWindow does not pass the turn count", () => {
    expect(growTimelineWindow(40, 30, 50)).toBe(50);
    expect(growTimelineWindow(40, 30, 80)).toBe(70);
    expect(growTimelineWindow(80, 30, 80)).toBe(80);
  });
});
