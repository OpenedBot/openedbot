import { describe, expect, test } from "bun:test";
import type { HermesTransportClientConfig } from "@openedbot/hermes";
import { RUNTIME_EXECUTION_VERBS, runtimeAdminClient } from "../src/application/runtime-admin-client";

/** The API's only Hermes client reads and administers, never runs a turn. */
describe("runtimeAdminClient", () => {
  const sent: string[] = [];
  const transport: HermesTransportClientConfig["transport"] = {
    kind: "relay",
    send: async (path: string) => {
      sent.push(path);
      return Response.json({ status: "ok" });
    },
  };

  test("a read goes through the runtime transport", async () => {
    const client = runtimeAdminClient({ transport, profile: null });
    expect(await client.health()).toMatchObject({ status: "ok" });
    expect(sent.length).toBeGreaterThan(0);
  });

  test("every execution verb is refused before any request, even through a cast", async () => {
    const client = runtimeAdminClient({ transport, profile: null }) as unknown as Record<string, (...args: unknown[]) => unknown>;
    const before = sent.length;
    for (const verb of RUNTIME_EXECUTION_VERBS) {
      expect(() => client[verb]!("x")).toThrow(expect.objectContaining({ name: "RUNTIME_EXECUTION_FORBIDDEN" }));
    }
    expect(sent.length).toBe(before);
  });
});
