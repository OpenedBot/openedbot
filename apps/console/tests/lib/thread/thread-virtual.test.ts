import { describe, expect, test } from "bun:test";
import { parseThreadHistoryLimit } from "@openedbot/conversation/domain/thread-history-cursor";
import type { Entry } from "../../../src/lib/thread/thread-timeline-model";
import {
  charsPerLineFor,
  estimateEntryHeight,
  estimateMarkdownHeight,
  holdRows,
  layoutRows,
  overscanFor,
  rowsAround,
  spacerHeights,
  tailRows,
  THREAD_HISTORY_PAGE_TURNS,
  THREAD_OVERSCAN_MIN_PX,
  timelineTurns,
} from "../../../src/lib/thread/thread-virtual";

describe("timelineTurns", () => {
  test("a user entry opens a turn, so the tools and the answer stay with their question", () => {
    const entries = [
      { key: "r0", kind: "assistant" },
      { key: "u1", kind: "user" },
      { key: "t1", kind: "tools" },
      { key: "a1", kind: "assistant" },
      { key: "u2", kind: "user" },
      { key: "a2", kind: "assistant" },
    ];
    expect(timelineTurns(entries)).toEqual([
      { key: "r0", start: 0, end: 1 },
      { key: "u1", start: 1, end: 4 },
      { key: "u2", start: 4, end: 6 },
    ]);
  });

  test("entries without a kind are one turn each, and no entry is no turn", () => {
    expect(timelineTurns([{ key: "a" }, { key: "b" }]).map((turn) => turn.key)).toEqual(["a", "b"]);
    expect(timelineTurns([])).toEqual([]);
  });
});

describe("row layout", () => {
  const heights = [100, 300, 50, 200, 400];
  const layout = layoutRows(heights, 10);

  test("offsets add each row and one gap; the total has no trailing gap", () => {
    expect(layout.offsets).toEqual([0, 110, 420, 480, 690]);
    expect(layout.total).toBe(1090);
  });

  test("the rows around the view, overscan included", () => {
    // View [450, 550): only the rows that cross it.
    expect(rowsAround(layout, heights, { top: 450, height: 100 }, 0)).toEqual({ first: 2, last: 3 });
    // 200 px of overscan reaches row 1 above and row 4 below.
    expect(rowsAround(layout, heights, { top: 450, height: 100 }, 200)).toEqual({ first: 1, last: 4 });
    // A view past the end keeps the last row; before the start, the first.
    expect(rowsAround(layout, heights, { top: 5_000, height: 100 }, 0)).toEqual({ first: 4, last: 4 });
    expect(rowsAround(layout, heights, { top: -500, height: 100 }, 0)).toEqual({ first: 0, last: 0 });
  });

  test("the tail fills the view from the bottom", () => {
    expect(tailRows(layout, heights, 300, 0)).toEqual({ first: 4, last: 4 });
    expect(tailRows(layout, heights, 600, 0)).toEqual({ first: 3, last: 4 });
    expect(tailRows(layoutRows([], 10), [], 600, 0)).toEqual({ first: 0, last: -1 });
  });

  test("the selection or the focus holds its rows, keeping the range contiguous", () => {
    expect(holdRows({ first: 3, last: 4 }, [0], 5)).toEqual({ first: 0, last: 4 });
    expect(holdRows({ first: 1, last: 2 }, [4, 9, -1], 5)).toEqual({ first: 1, last: 4 });
  });

  test("the spacers stand for the unmounted rows and their gaps, so nothing moves", () => {
    const range = { first: 2, last: 3 };
    const { top, bottom } = spacerHeights(layout, heights, range, 10);
    // top + gap + rows 2..3 with their gap + gap + bottom == total.
    expect(top).toBe(410);
    expect(bottom).toBe(400);
    expect(top + 10 + 50 + 10 + 200 + 10 + bottom).toBe(layout.total);
    expect(spacerHeights(layout, heights, { first: 0, last: 4 }, 10)).toEqual({ top: 0, bottom: 0 });
  });

  test("the overscan is a viewport, never less than its floor", () => {
    expect(overscanFor(200)).toBe(THREAD_OVERSCAN_MIN_PX);
    expect(overscanFor(1_200)).toBe(1_200);
  });
});

describe("estimates", () => {
  test("code, headings and tables weigh more than their characters", () => {
    const chars = charsPerLineFor(740);
    const prose = estimateMarkdownHeight("Un paragraphe court.", chars);
    const code = estimateMarkdownHeight("```ts\n" + "const a = 1;\n".repeat(20) + "```", chars);
    expect(code).toBeGreaterThan(prose * 10);
    const table = estimateMarkdownHeight("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |", chars);
    expect(table).toBe(12 + 3 * 37);
  });

  test("a long line wraps at the column's width", () => {
    const line = "mot ".repeat(100);
    expect(estimateMarkdownHeight(line, charsPerLineFor(370))).toBeGreaterThan(estimateMarkdownHeight(line, charsPerLineFor(740)));
  });

  test("an image attachment adds its tile", () => {
    const user = { kind: "user", key: "u", text: "voici", runId: null, steeredIntoActive: false, steeredIntoSettled: false, targetId: "message:u" } as Entry;
    const withImage = { ...user, attachments: [{ type: "attachment", kind: "image", name: "a.png", contentType: "image/png", bytes: 1 }] } as Entry;
    expect(estimateEntryHeight(withImage, 80) - estimateEntryHeight(user, 80)).toBe(290);
  });
});

test("« load earlier » names the API's page size", () => {
  expect(THREAD_HISTORY_PAGE_TURNS).toBe(parseThreadHistoryLimit(undefined));
});
