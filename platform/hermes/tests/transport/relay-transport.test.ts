import { describe, expect, test } from "bun:test";
import { HermesClient, HermesClientError } from "../../src/index";
import { createRelayTransport, RelayDialError, type RelayDialer, type RelayRequest } from "../../src/transport/relay";

function dialer(handler: (request: RelayRequest, signal?: AbortSignal) => Promise<Response> | Response) {
  const requests: RelayRequest[] = [];
  const dial: RelayDialer = async (request, signal) => {
    requests.push(request);
    return handler(request, signal);
  };
  return { dial, requests };
}

function relay(handler: Parameters<typeof dialer>[0]) {
  const { dial, requests } = dialer(handler);
  return { transport: createRelayTransport({ runtimeId: "rt-1", dial }), requests };
}

async function failure(promise: Promise<unknown>): Promise<HermesClientError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(HermesClientError);
  return error as HermesClientError;
}

describe("relay transport: allowlist and request shape", () => {
  test("refuses a path outside the allowlist without dialing", async () => {
    const { transport, requests } = relay(() => Response.json({}));
    const error = await failure(transport.send("/v1/browser-control/x", {}, "safe"));
    expect(error.code).toBe("HERMES_LINK_PATH_FORBIDDEN");
    expect(error.status).toBe(403);
    expect(error.requestDelivery).toBe("not_sent");
    expect(requests).toHaveLength(0);
  });

  test("refuses a verb the allowlist does not list for that path", async () => {
    const { transport, requests } = relay(() => Response.json({}));
    const error = await failure(transport.send("/api/mcp/servers", { method: "POST" }, "mutation"));
    expect(error.code).toBe("HERMES_LINK_PATH_FORBIDDEN");
    expect(requests).toHaveLength(0);
  });

  test("forwards only the contract headers, lowercased, with a JSON accept by default", async () => {
    const { transport, requests } = relay(() => Response.json({}));
    const response = await transport.send("/v1/runs", {
      method: "post",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "run-1",
        Authorization: "Bearer must-not-cross",
        Cookie: "session=nope",
        Host: "evil.example",
        "X-Forwarded-For": "1.2.3.4",
      },
      body: JSON.stringify({ input: "hi" }),
    }, "mutation");
    await response.body?.cancel();
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.path).toBe("/v1/runs");
    expect(requests[0]?.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": "run-1",
    });
    expect(new TextDecoder().decode(requests[0]?.body as Uint8Array)).toBe('{"input":"hi"}');
  });

  test("keeps the query and Last-Event-ID for the events route", async () => {
    const { transport, requests } = relay(() => new Response("", { headers: { "content-type": "text/event-stream" } }));
    const response = await transport.send("/v1/runs/run_1/events?since=12", {
      headers: { Accept: "text/event-stream", "Last-Event-ID": "12" },
    }, "safe");
    await response.body?.cancel();
    expect(requests[0]?.path).toBe("/v1/runs/run_1/events?since=12");
    expect(requests[0]?.headers).toEqual({ accept: "text/event-stream", "last-event-id": "12" });
    expect(requests[0]?.body).toBeNull();
  });

  test("refuses a request body above 1 MiB before dialing", async () => {
    const { transport, requests } = relay(() => Response.json({}));
    const error = await failure(transport.send("/v1/runs", {
      method: "POST",
      body: "x".repeat(1024 * 1024 + 1),
    }, "mutation"));
    expect(error.code).toBe("HERMES_PROTOCOL_LIMIT");
    expect(error.status).toBe(413);
    expect(error.requestDelivery).toBe("not_sent");
    expect(requests).toHaveLength(0);
  });

  test("only relays Content-Type and Retry-After back", async () => {
    const { transport } = relay(() => new Response("{}", {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "3", "set-cookie": "a=b", "x-hermes-host": "leak" },
    }));
    const response = await transport.send("/v1/runs", { method: "POST" }, "mutation");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-hermes-host")).toBeNull();
    await response.body?.cancel();
  });
});

describe("relay transport: delivery certainty table", () => {
  test("an already aborted signal is not_sent and never dials", async () => {
    const { transport, requests } = relay(() => Response.json({}));
    const controller = new AbortController();
    controller.abort("early");
    const error = await transport.send("/v1/runs", { method: "POST", signal: controller.signal }, "mutation")
      .catch((caught: unknown) => caught);
    expect((error as Error).name).toBe("AbortError");
    expect((error as { requestDelivery?: string }).requestDelivery).toBe("not_sent");
    expect(requests).toHaveLength(0);
  });

  test("a failure before dispatch is not_sent HERMES_UNREACHABLE", async () => {
    const { transport } = relay(() => {
      throw new RelayDialError("no link", "before_dispatch", "LINK_BUSY");
    });
    const error = await failure(transport.send("/v1/runs", { method: "POST" }, "mutation"));
    expect(error.code).toBe("HERMES_UNREACHABLE");
    expect(error.status).toBe(503);
    expect(error.requestDelivery).toBe("not_sent");
  });

  test("a path refused by the host before dispatch keeps its 403 code", async () => {
    const { transport } = relay(() => {
      throw new RelayDialError("path not allowed", "before_dispatch", "HERMES_LINK_PATH_FORBIDDEN");
    });
    const error = await failure(transport.send("/health", {}, "safe"));
    expect(error.code).toBe("HERMES_LINK_PATH_FORBIDDEN");
    expect(error.status).toBe(403);
    expect(error.requestDelivery).toBe("not_sent");
  });

  test("an operator refused before dispatch keeps HERMES_OPERATOR_UNAVAILABLE, not_sent", async () => {
    const { transport } = relay(() => {
      throw new RelayDialError("operator socket down", "before_dispatch", "HERMES_OPERATOR_UNAVAILABLE");
    });
    const error = await failure(transport.send("/hermes-setup/capabilities", {}, "safe"));
    expect(error.code).toBe("HERMES_OPERATOR_UNAVAILABLE");
    expect(error.status).toBe(503);
    expect(error.requestDelivery).toBe("not_sent");
  });

  test("a failure after dispatch is ambiguous for a mutation and unknown for a read", async () => {
    const { transport } = relay(() => {
      throw new RelayDialError("link lost", "after_dispatch");
    });
    const mutation = await failure(transport.send("/v1/runs", { method: "POST" }, "mutation"));
    expect(mutation.code).toBe("HERMES_UNREACHABLE");
    expect(mutation.requestDelivery).toBe("ambiguous");
    const read = await failure(transport.send("/health", {}, "safe"));
    expect(read.requestDelivery).toBeNull();
  });

  test("an unclassified failure is treated as after dispatch", async () => {
    const { transport } = relay(() => {
      throw new Error("socket hang up");
    });
    const error = await failure(transport.send("/v1/runs/run_1/stop", { method: "POST" }, "mutation"));
    expect(error.code).toBe("HERMES_UNREACHABLE");
    expect(error.requestDelivery).toBe("ambiguous");
  });

  test("an abort raised by the dialer is ambiguous", async () => {
    const { transport } = relay(() => {
      throw new DOMException("aborted", "AbortError");
    });
    const error = await transport.send("/v1/runs", { method: "POST" }, "mutation")
      .catch((caught: unknown) => caught);
    expect((error as Error).name).toBe("AbortError");
    expect((error as { requestDelivery?: string }).requestDelivery).toBe("ambiguous");
  });

  test("a body that breaks after the response is response_received HERMES_STREAM_INTERRUPTED", async () => {
    const { transport } = relay(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: run.delta\ndata: {}\n\n"));
        controller.error(new Error("link closed"));
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const response = await transport.send("/v1/runs/run_1/events", {}, "safe");
    expect(response.status).toBe(200);
    const error = await failure(response.text());
    expect(error.code).toBe("HERMES_STREAM_INTERRUPTED");
    expect(error.requestDelivery).toBe("response_received");
  });

  test("a 204 without body is returned as is", async () => {
    const { transport } = relay(() => new Response(null, { status: 204 }));
    const response = await transport.send("/v1/runs/run_1/stop", { method: "POST" }, "mutation");
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});

describe("HermesClient over the relay transport", () => {
  test("probes through the link with the profile prefix", async () => {
    const { transport, requests } = relay(() => Response.json({ ok: true }));
    const client = new HermesClient({ transport, profile: "prod-1" });
    await client.probe();
    expect(requests.map((request) => request.path).sort()).toEqual(["/p/prod-1/health", "/p/prod-1/v1/capabilities"]);
  });

  test("creates a run and streams its events, carrying the SSE id as sequence", async () => {
    const { transport, requests } = relay((request) => {
      if (request.path === "/v1/runs") return Response.json({ run_id: "run_1" });
      return new Response([
        "id: 1\nevent: run.delta\ndata: {\"event\":\"message.delta\",\"run_id\":\"run_1\",\"timestamp\":1,\"delta\":\"hi\"}\n\n",
        "event: run.completed\ndata: {\"event\":\"run.completed\",\"run_id\":\"run_1\",\"timestamp\":2}\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const client = new HermesClient({ transport });
    const runId = await client.createRun({ input: "hi", instructions: "", sessionId: "s1", idempotencyKey: "openedbot-run-1" });
    expect(runId).toBe("run_1");
    expect(requests[0]?.headers["idempotency-key"]).toBe("openedbot-run-1");
    const events = [];
    for await (const event of client.events("run_1", new AbortController().signal)) events.push(event);
    expect(events.map((event) => event.sequence)).toEqual([1, undefined]);
    expect(events[0]?.event).toBe("message.delta");
  });

  test("signals the open stream before its first event, never on a refused one", async () => {
    const order: string[] = [];
    const { transport } = relay(() => new Response(
      "event: run.delta\ndata: {\"event\":\"message.delta\",\"run_id\":\"run_1\",\"timestamp\":1,\"delta\":\"hi\"}\n\n",
      { headers: { "content-type": "text/event-stream" } },
    ));
    const client = new HermesClient({ transport });
    const stream = client.events("run_1", new AbortController().signal, { onOpen: () => order.push("open") });
    for await (const event of stream) order.push(event.event);
    expect(order).toEqual(["open", "message.delta"]);

    let opened = false;
    const refused = new HermesClient({ transport: relay(() => Response.json({}, { status: 200 })).transport });
    const failing = refused.events("run_1", new AbortController().signal, { onOpen: () => { opened = true; } });
    await expect(failing.next()).rejects.toThrow();
    expect(opened).toBe(false);
  });

  test("reads the recent session transcript through the relay in chronological order", async () => {
    // `order=latest` pagine en arrière depuis le message le plus récent, mais
    // sert la page dans l'ordre chronologique (`SessionDB.get_messages`) : le
    // client la rend telle quelle.
    const { transport, requests } = relay(() => Response.json({
      object: "list",
      data: [{ id: "old" }, { id: "new" }],
    }));
    const client = new HermesClient({ transport });
    await expect(client.sessionMessages("s1")).resolves.toEqual([{ id: "old" }, { id: "new" }]);
    expect(requests[0]?.path).toBe("/api/sessions/s1/messages?limit=128&order=latest");
  });

  test("a mutation refused by the allowlist surfaces as not_sent", async () => {
    const { transport } = relay(() => Response.json({}));
    const client = new HermesClient({ transport });
    // L'identifiant encodé contient `..` : le chemin est refusé avant tout envoi.
    const error = await failure(client.steerRun("run_1/../admin", { text: "x" }));
    expect(error.code).toBe("HERMES_LINK_PATH_FORBIDDEN");
    expect(error.requestDelivery).toBe("not_sent");
  });

  test("a steer returns its received status without waiting for body cancellation", async () => {
    let cancelCalled = false;
    const { transport } = relay(() => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalled = true;
        // Reproduit le saut HTTP worker -> API : l'abandon est bien parti,
        // mais sa propagation réseau peut rester pendante après le `res`.
        return new Promise<void>(() => undefined);
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new HermesClient({ transport });

    const outcome = await Promise.race([
      client.steerRun("run_1", { text: "continue" }),
      Bun.sleep(50).then(() => "cancel_timeout" as const),
    ]);
    expect(outcome).toBe(200);
    expect(cancelCalled).toBe(true);
  });
});
