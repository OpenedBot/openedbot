import { expect, test } from "bun:test";
import {
  markMentions,
  mentionEndingAt,
  mentionRanges,
  removeRange,
} from "../../../src/lib/composer/composer-mentions";

const SLUGS = ["neo", "neo-2"];

test("mentionRanges finds known @slug tokens and nothing else", () => {
  expect(mentionRanges("a @neo b @nobody c@neo", SLUGS)).toEqual([{ start: 2, end: 6 }]);
  expect(mentionRanges("@neo-2 and @neo", SLUGS)).toEqual([
    { start: 0, end: 6 },
    { start: 11, end: 15 },
  ]);
  expect(mentionRanges("@neo", [])).toEqual([]);
});

test("mentionEndingAt only matches a caret right after the token", () => {
  expect(mentionEndingAt("hi @neo", 7, SLUGS)).toEqual({ start: 3, end: 7 });
  expect(mentionEndingAt("hi @neo", 6, SLUGS)).toBeNull();
  expect(mentionEndingAt("hi @neo ", 8, SLUGS)).toBeNull();
});

test("removeRange drops the token as one unit", () => {
  expect(removeRange("hi @neo there", { start: 3, end: 7 })).toEqual({ text: "hi  there", caret: 3 });
});

test("markMentions splits text without losing or adding a character", () => {
  const value = "hi @neo, @neo-2!";
  const out = markMentions([{ kind: "text" as const, text: value }], mentionRanges(value, SLUGS));
  expect(out.map((s) => s.text).join("")).toBe(value);
  expect(out.filter((s) => s.kind === "mention").map((s) => s.text)).toEqual(["@neo", "@neo-2"]);
});
