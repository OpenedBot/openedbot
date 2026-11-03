import { describe, expect, test } from "bun:test";
import { HermesClient, HermesClientError } from "../../src/index";

function clientAnswering(response: () => Response): HermesClient {
  return new HermesClient({ transport: { kind: "direct", send: async () => response() } });
}

// Measured on the lab host (Hermes `api_server._draining_response`): a gateway
// restarting gracefully answers a new run with this exact envelope.
const DRAINING_BODY = {
  error: { message: "Gateway is draining existing work; retry shortly.", type: "invalid_request_error", param: null, code: "gateway_draining" },
};

describe("a gateway restarting gracefully", () => {
  test("its 503 gateway_draining is a refusal before creation, never an ambiguous create", async () => {
    const client = clientAnswering(() => Response.json(DRAINING_BODY, { status: 503, headers: { "Retry-After": "1" } }));
    const error = await client.createRun({ input: "bonjour", instructions: "", sessionId: "s1" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HermesClientError);
    expect(error).toMatchObject({ status: 503, code: "HERMES_GATEWAY_DRAINING", requestDelivery: "response_received", retryAfterMs: 1_000 });
  });

  test("any other 503 keeps the ambiguous-create path", async () => {
    const client = clientAnswering(() => Response.json({ error: { message: "boom", code: "other" } }, { status: 503 }));
    const error = await client.createRun({ input: "bonjour", instructions: "", sessionId: "s1" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 503 });
    expect((error as HermesClientError).code).not.toBe("HERMES_GATEWAY_DRAINING");
  });
});
