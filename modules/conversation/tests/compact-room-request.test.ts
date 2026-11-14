import { describe, expect, test } from "bun:test";
import { ROOM_COMPACT_MIN_CHARS } from "@openedbot/contracts-api";
import { HISTORY_CHAR_BUDGET, KEEP_BUDGET_RATIO } from "../src/domain/thread-compaction";

describe("seuil de compaction à la demande", () => {
  test("le seuil de la console est la queue récente que la compaction ne plie jamais", () => {
    expect(ROOM_COMPACT_MIN_CHARS).toBe(Math.floor(HISTORY_CHAR_BUDGET * KEEP_BUDGET_RATIO));
  });
});
