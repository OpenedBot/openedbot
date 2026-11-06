import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLoopHealth,
  HEALTH_FILE_MAX_AGE_MS,
  isLoopHealthy,
  LOOP_STALL_MS,
} from "../src/infrastructure/loop-health";
import { captureLogEvents } from "@openedbot/platform-observability/log/test-logger";

describe("worker loop health file", () => {
  let directory: string;
  let file: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "openedbot-worker-health-"));
    file = join(directory, "alive");
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("is refreshed while the loop turns and goes stale once it stops", async () => {
    let now = Date.now();
    const health = createLoopHealth(file, () => now);

    expect(await isLoopHealthy(file)).toBe(false);
    await health.report();
    expect(await isLoopHealthy(file)).toBe(true);
    expect(await isLoopHealthy(file, Date.now() + HEALTH_FILE_MAX_AGE_MS + 1_000)).toBe(false);

    rmSync(file);
    now += LOOP_STALL_MS + 1;
    const { records } = await captureLogEvents(async () => {
      await health.report();
      await health.report();
    });
    expect(existsSync(file)).toBe(false);
    const stalls = records.filter((record) => record.event === "worker.loop_stalled");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.level).toBe(50);

    health.progressed();
    await health.report();
    expect(await isLoopHealthy(file)).toBe(true);
  });

  test("without a configured file only the stall is reported", async () => {
    const health = createLoopHealth(null);
    const { records } = await captureLogEvents(() => health.report());
    expect(records).toEqual([]);
  });
});
