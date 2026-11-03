import { describe, expect, test } from "bun:test";
import { timedRuntimeClient } from "../src/maintenance/profile-provisions";

describe("timedRuntimeClient", () => {
  test("each host call of the baseline is summed into the pass's timings, failures included", async () => {
    const timings: Record<string, number> = {};
    const fake = {
      hostProfileInventory: async () => ({ profiles: [] }),
      hostSetProfileToolsets: async () => { throw new Error("refused"); },
      label: "not a function",
    };
    const factory = (() => fake) as never;
    const client = timedRuntimeClient(timings, factory)({} as never, {} as never) as unknown as typeof fake;

    await client.hostProfileInventory();
    await client.hostProfileInventory();
    await expect(client.hostSetProfileToolsets()).rejects.toThrow("refused");

    expect(Object.keys(timings).sort()).toEqual(["baseline.hostProfileInventoryMs", "baseline.hostSetProfileToolsetsMs"]);
    expect(client.label).toBe("not a function");
  });
});
