import { describe, expect, test } from "bun:test";
import {
  nextPillExpanded,
  PILL_COMPACT_PX,
  PILL_LINE_PX,
  PILL_PAD_BOTTOM_PX,
  PILL_PAD_TOP_PX,
  pillShellHeight,
} from "../../../src/lib/dev/thread-lab-composer";

describe("nextPillExpanded", () => {
  test("one line at the compact width stays a pill", () => {
    expect(nextPillExpanded(false, { value: "Bonjour", scrollHeight: PILL_LINE_PX })).toBe(false);
  });

  test("a wrap to a second line opens it", () => {
    expect(nextPillExpanded(false, { value: "x".repeat(200), scrollHeight: PILL_LINE_PX * 2 })).toBe(true);
  });

  test("a newline opens it even before the field has grown", () => {
    expect(nextPillExpanded(false, { value: "a\n", scrollHeight: PILL_LINE_PX })).toBe(true);
  });

  test("once open, a field that fits one line again at full width stays open", () => {
    expect(nextPillExpanded(true, { value: "x".repeat(60), scrollHeight: PILL_LINE_PX })).toBe(true);
  });

  test("emptying the field (sent or cleared) closes it", () => {
    expect(nextPillExpanded(true, { value: "", scrollHeight: PILL_LINE_PX })).toBe(false);
  });
});

describe("pillShellHeight", () => {
  test("compact is one fixed line, whatever the content", () => {
    expect(pillShellHeight(false, 120)).toBe(PILL_COMPACT_PX);
  });

  test("expanded wraps the capped content between the top pad and the action row", () => {
    expect(pillShellHeight(true, 96)).toBe(PILL_PAD_TOP_PX + 96 + PILL_PAD_BOTTOM_PX);
    expect(pillShellHeight(true, 0)).toBe(PILL_PAD_TOP_PX + PILL_LINE_PX + PILL_PAD_BOTTOM_PX);
  });
});
