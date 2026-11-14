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

  test("Hermes 0.23 session-authority refusals requeue the same way", async () => {
    for (const code of ["runtime_draining", "storage_unavailable", "chain_moved"]) {
      const client = clientAnswering(() => Response.json({ error: { message: code, code } }, { status: 503, headers: { "Retry-After": "1" } }));
      const error = await client.createRun({ input: "bonjour", instructions: "", sessionId: "s1" }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ status: 503, code: "HERMES_GATEWAY_DRAINING", requestDelivery: "response_received" });
    }
  });

  test("admission_queued is an accepted turn, never a retryable refusal", async () => {
    const client = clientAnswering(() => Response.json({ error: { message: "queued", code: "admission_queued" } }, { status: 503, headers: { "x-should-retry": "false" } }));
    const error = await client.createRun({ input: "bonjour", instructions: "", sessionId: "s1" }).catch((caught: unknown) => caught);
    expect((error as HermesClientError).code).not.toBe("HERMES_GATEWAY_DRAINING");
  });

  test("session_db_unavailable retries deterministic session preparation, never an ambiguous run creation", async () => {
    const client = clientAnswering(() => Response.json({ error: { message: "Session database unavailable", code: "session_db_unavailable" } }, {
      status: 503, headers: { "Retry-After": "1" },
    }));
    const session = await client.ensureSession("same-session", "test").catch((error: unknown) => error);
    expect(session).toMatchObject({ code: "HERMES_GATEWAY_DRAINING", status: 503, requestDelivery: "response_received", retryAfterMs: 1_000 });
    const run = await client.createRun({ input: "hello", instructions: "", sessionId: "same-session" }).catch((error: unknown) => error);
    expect(run).toMatchObject({ code: "HERMES_RESPONSE_INVALID", status: 503 });
  });

  test("session preparation still refuses arbitrary 503 errors", async () => {
    const client = clientAnswering(() => Response.json({ error: { message: "unknown failure", code: "other" } }, { status: 503 }));
    const error = await client.ensureSession("same-session", "test").catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "HERMES_RESPONSE_INVALID", status: 503 });
  });

  test("any other 503 keeps the ambiguous-create path", async () => {
    const client = clientAnswering(() => Response.json({ error: { message: "boom", code: "other" } }, { status: 503 }));
    const error = await client.createRun({ input: "bonjour", instructions: "", sessionId: "s1" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 503 });
    expect((error as HermesClientError).code).not.toBe("HERMES_GATEWAY_DRAINING");
  });
});
