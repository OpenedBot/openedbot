import { describe, expect, test } from "bun:test";
import { nextComposerExpanded } from "../../../src/lib/composer/composer-pill";

const LINE = 20;

describe("nextComposerExpanded", () => {
  test("one line stays a pill", () => {
    expect(nextComposerExpanded(false, { value: "Bonjour", scrollHeight: LINE }, LINE)).toBe(false);
  });

  test("a wrapped line opens the card", () => {
    expect(nextComposerExpanded(false, { value: "x".repeat(200), scrollHeight: LINE * 2 }, LINE)).toBe(true);
  });

  test("a newline opens the card even before it wraps", () => {
    expect(nextComposerExpanded(false, { value: "a\n", scrollHeight: LINE }, LINE)).toBe(true);
  });

  test("the card stays open while the field holds text, even if it fits one line again", () => {
    expect(nextComposerExpanded(true, { value: "court", scrollHeight: LINE }, LINE)).toBe(true);
  });

  test("an empty field closes the card", () => {
    expect(nextComposerExpanded(true, { value: "", scrollHeight: LINE }, LINE)).toBe(false);
  });
});
