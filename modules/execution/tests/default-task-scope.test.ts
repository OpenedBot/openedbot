import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("worker default task scope", () => {
  test("scheduled routines and handoffs target only the bot's single thread", () => {
    const scheduledRoutines = readFileSync(new URL("../src/application/routines.ts", import.meta.url), "utf8");
    const workerHandoff = readFileSync(new URL("../src/application/runner/handoff.ts", import.meta.url), "utf8");

    for (const source of [scheduledRoutines, workerHandoff]) {
      // Un bot, un fil : `is_default` suffit. `task_status` a disparu avec les
      // sessions extra (migration 0021), la condition ne doit plus reparaître.
      expect(source).toMatch(/thread[s]?\s+(?:t|thread)[\s\S]{0,180}\.is_default/u);
      expect(source).not.toContain("task_status");
    }
  });
});
