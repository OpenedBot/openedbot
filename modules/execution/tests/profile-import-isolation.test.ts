import { expect, test } from "bun:test";
import type { HermesClient } from "@openedbot/hermes";
import { resolveToolsetScope } from "../src/application/runner";

test("imported profiles use their proven isolation independently of deletion ownership", async () => {
  const context = { hermesProfile: "scout", hermesProfileManaged: false };
  for (const isolation of ["isolated", "missing", "not_partitioned"] as const) {
    const client: Pick<HermesClient, "probeProfileIsolation"> = { probeProfileIsolation: async () => isolation };
    expect(await resolveToolsetScope(client, context)).toBe(isolation === "isolated" ? "profile" : "runtime");
  }
  const unavailable = { probeProfileIsolation: async (): Promise<never> => { throw new Error("offline"); } };
  expect(await resolveToolsetScope(unavailable, context)).toBe("runtime");
  expect(await resolveToolsetScope(unavailable, { ...context, hermesProfile: null })).toBe("runtime");
});
