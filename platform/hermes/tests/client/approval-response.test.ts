import { describe, expect, test } from "bun:test";
import { HermesClient, HermesClientError } from "../../src/index";

function recordingClient(): { client: HermesClient; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const client = new HermesClient({ transport: { kind: "direct", send: async (_path: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ object: "hermes.run.approval_response", run_id: "run_1", choice: "once", resolved: 1 });
  } } });
  return { client, bodies };
}

describe("approval response", () => {
  test("carries the exact request_id of the gate it answers", async () => {
    const { client, bodies } = recordingClient();
    await client.respondApproval("run_1", "once", undefined, " req-42 ");
    expect(bodies).toEqual([{ choice: "once", approved: true, request_id: "req-42" }]);
  });

  test("without a request id the answer stays positional", async () => {
    const { client, bodies } = recordingClient();
    await client.respondApproval("run_1", "deny");
    expect(bodies).toEqual([{ choice: "deny", approved: false }]);
  });

  test("an empty or oversized request id is refused before any send", async () => {
    const { client, bodies } = recordingClient();
    for (const requestId of ["   ", "r".repeat(257)]) {
      const error = await client.respondApproval("run_1", "once", undefined, requestId).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HermesClientError);
      expect(error).toMatchObject({ code: "BODY_INVALID", requestDelivery: null });
    }
    expect(bodies).toEqual([]);
  });
});
