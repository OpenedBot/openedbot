import { describe, expect, test } from "bun:test";
import { createBackgroundJobs, type BackgroundJob } from "../src/application/background-jobs";

function job(name: string, runs: string[], options: Partial<BackgroundJob> = {}): BackgroundJob {
  return { name, everyMs: 1_000, run: async () => { runs.push(name); }, ...options };
}

async function settle(work: Promise<void>[]): Promise<void> {
  await Promise.all(work.splice(0));
}

describe("createBackgroundJobs", () => {
  // A host-calling pass waits until a dead API instance is decidable (60 s
  // without heartbeat); the others still run on the first tick.
  test("firstAfterMs holds the first pass back, counted from the first tick", async () => {
    const runs: string[] = [];
    const tracked: Promise<void>[] = [];
    const jobs = createBackgroundJobs(
      [job("plain", runs), job("host", runs, { firstAfterMs: 60_000 })],
      new AbortController().signal,
      (work) => { tracked.push(work); },
    );
    jobs.tick(1_000_000);
    await settle(tracked);
    expect(runs).toEqual(["plain"]);

    jobs.tick(1_059_999);
    await settle(tracked);
    expect(runs).toEqual(["plain", "plain"]);

    jobs.tick(1_060_000);
    await settle(tracked);
    expect(runs).toEqual(["plain", "plain", "host"]);

    // Then its own cadence, like any job.
    jobs.tick(1_060_500);
    await settle(tracked);
    expect(runs).toEqual(["plain", "plain", "host"]);
  });

  test("stats count each job's passes and their duration", async () => {
    const tracked: Promise<void>[] = [];
    const jobs = createBackgroundJobs(
      [{ name: "slow", everyMs: 0, run: async () => { await Bun.sleep(5); } }],
      new AbortController().signal,
      (work) => { tracked.push(work); },
    );
    jobs.tick(1);
    await settle(tracked);
    jobs.tick(2);
    await settle(tracked);
    const [slow] = jobs.stats();
    expect(slow?.job).toBe("slow");
    expect(slow?.runs).toBe(2);
    expect(slow!.maxMs).toBeGreaterThanOrEqual(4);
    expect(slow!.totalMs).toBeGreaterThanOrEqual(slow!.maxMs);
  });
});
