import { describe, expect, test } from "bun:test";
import { isHermesRunWorking } from "../../src/domain/silent-run";

describe("isHermesRunWorking", () => {
  test("a silent run that Hermes still runs is alive", () => {
    for (const status of ["queued", "started", "running", "waiting_for_approval"] as const) {
      expect(isHermesRunWorking(status)).toBe(true);
    }
  });

  test("a stopping or finished run is not", () => {
    for (const status of ["stopping", "completed", "failed", "interrupted", "cancelled"] as const) {
      expect(isHermesRunWorking(status)).toBe(false);
    }
  });
});
