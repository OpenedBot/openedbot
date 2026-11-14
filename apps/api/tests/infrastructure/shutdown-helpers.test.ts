import { describe, expect, test } from "bun:test";
import { flushLinkPersistence } from "../../src/infrastructure/link-shutdown";
import { readRequestBodyLimit } from "../../src/infrastructure/request-body-limit";

describe("API entrypoint helpers", () => {
  test("the link flush is awaited when the database answers", async () => {
    const errors: unknown[] = [];
    let flushed = false;
    await flushLinkPersistence({ flushPersistence: async () => { flushed = true; } }, (error) => errors.push(error));
    expect(flushed).toBe(true);
    expect(errors).toEqual([]);
  });

  test("a flush that never ends is cut at the timeout and reported, not awaited forever", async () => {
    const errors: unknown[] = [];
    const started = Date.now();
    await flushLinkPersistence({ flushPersistence: () => new Promise<void>(() => {}) }, (error) => errors.push(error), 20);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(String(errors[0])).toContain("Link persistence shutdown timeout");
  });

  test("a failing flush is reported once", async () => {
    const errors: unknown[] = [];
    await flushLinkPersistence({ flushPersistence: async () => { throw new Error("db gone"); } }, (error) => errors.push(error));
    expect(errors.map(String)).toEqual(["Error: db gone"]);
  });

  test("the request body limit defaults to 16 MiB and refuses what is out of bounds", () => {
    expect(readRequestBodyLimit(undefined)).toBe(16 * 1024 * 1024);
    expect(readRequestBodyLimit("1024")).toBe(1024);
    for (const bad of ["0", "-1", "1.5", "abc", String(64 * 1024 * 1024 + 1)]) {
      expect(() => readRequestBodyLimit(bad)).toThrow("API_MAX_BODY_BYTES");
    }
  });
});
