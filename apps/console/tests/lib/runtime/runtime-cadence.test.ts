import { describe, expect, test } from "bun:test";
import type { RuntimeConfigurationDto } from "@openedbot/contracts-api";
import { RUNTIME_DISCONNECTED_REFETCH_MS, RUNTIME_REFETCH_MS, runtimeRefetchMs } from "../../../src/lib/runtime/runtime-cadence";

const configuration = (runtime: unknown) => ({ runtime }) as unknown as RuntimeConfigurationDto;

describe("runtime reread cadence (rework-flux-api step 5e)", () => {
  test("a live link is a safety net of a minute", () => {
    expect(RUNTIME_REFETCH_MS).toBe(60_000);
    expect(runtimeRefetchMs(configuration({ reachability: "connector", link: { connected: true, live: true } }))).toBe(60_000);
  });

  test("a closed link, a dead one, or a pairing not opened yet stays brisk", () => {
    expect(runtimeRefetchMs(configuration({ reachability: "connector", link: { connected: false } }))).toBe(RUNTIME_DISCONNECTED_REFETCH_MS);
    expect(runtimeRefetchMs(configuration({ reachability: "connector", link: { connected: true, live: false } }))).toBe(RUNTIME_DISCONNECTED_REFETCH_MS);
  });

  test("no connector, or nothing read yet: the minute", () => {
    expect(runtimeRefetchMs(configuration({ reachability: "direct", link: null }))).toBe(60_000);
    expect(runtimeRefetchMs(undefined)).toBe(60_000);
    expect(runtimeRefetchMs(configuration(null))).toBe(60_000);
  });
});
