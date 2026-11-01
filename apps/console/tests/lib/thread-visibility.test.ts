import { describe, expect, test } from "bun:test";
import { partitionThreadVisibility, visibleRosterItems } from "../../src/lib/thread-visibility";

describe("partitionThreadVisibility", () => {
  test("absence de `hidden` reste visible, `true` part dans hidden", () => {
    const items = [{ id: "a" }, { id: "b", hidden: true }, { id: "c", hidden: false }];
    expect(partitionThreadVisibility(items)).toEqual({
      visible: [{ id: "a" }, { id: "c", hidden: false }],
      hidden: [{ id: "b", hidden: true }],
    });
  });
});

describe("visibleRosterItems", () => {
  test("écarte seulement `hidden: true`, préserve l'ordre serveur", () => {
    const items = [
      { id: "keep-first" },
      { id: "masked", hidden: true },
      { id: "keep-last", hidden: false },
    ];
    expect(visibleRosterItems(items).map((item) => item.id)).toEqual(["keep-first", "keep-last"]);
  });
});
