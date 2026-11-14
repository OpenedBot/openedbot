import { expect, test } from "bun:test";
import { type HermesClient, HermesClientError } from "@openedbot/hermes";
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

test("a gateway restarting cannot prove isolation: the run waits instead of losing the profile's toolsets", async () => {
  const context = { hermesProfile: "scout", hermesProfileManaged: true };
  for (const code of ["HERMES_GATEWAY_DRAINING", "HERMES_UNREACHABLE"] as const) {
    const error = new HermesClientError("restarting", 503, code, { requestDelivery: "response_received" });
    const restarting = { probeProfileIsolation: async (): Promise<never> => { throw error; } };
    await expect(resolveToolsetScope(restarting, context)).rejects.toBe(error);
  }
});
