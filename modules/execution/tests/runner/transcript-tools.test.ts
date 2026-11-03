import { describe, expect, test } from "bun:test";
import { TRANSCRIPT_TOOLS } from "../../src/application/runner";

describe("runner transcript tool compatibility", () => {
  test("re-reads after current and legacy Todo tool completions", () => {
    expect(TRANSCRIPT_TOOLS.has("todo_list")).toBe(true);
    expect(TRANSCRIPT_TOOLS.has("todo")).toBe(true);
  });
});
