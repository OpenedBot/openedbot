import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HermesClient, HermesClientError } from "../../src/index";
import type { HermesTransport } from "../../src/transport/types";
import { createDirectTransport } from "../../src/transport/direct";
import type { HermesRequestKind } from "../../src/transport/types";

type Seen = { method: string; path: string; headers: Record<string, string>; body: string };

let server: ReturnType<typeof Bun.serve>;
let endpoint: string;
const seen: Seen[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      seen.push({ method: request.method, path: `${url.pathname}${url.search}`, headers, body: await request.text() });
      if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { Location: "/health" } });
      if (url.pathname.endsWith("/health")) return Response.json({ status: "ok" });
      if (url.pathname.endsWith("/v1/capabilities")) return Response.json({ features: {} });
      return new Response("nope", { status: 404 });
    },
  });
  endpoint = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function transport(overrides: Partial<Parameters<typeof createDirectTransport>[0]> = {}) {
  return createDirectTransport({
    endpoint,
    token: "secret-token",
    policy: { environment: "test", testHttpUrl: endpoint },
    mtls: null,
    ...overrides,
  });
}

describe("direct transport: request shape", () => {
  test("sends the bearer, a JSON accept by default and the path verbatim", async () => {
    seen.length = 0;
    const response = await transport().send("/health?probe=1", {}, "safe");
    expect(response.status).toBe(200);
    await response.body?.cancel();
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.path).toBe("/health?probe=1");
    expect(seen[0]?.headers.authorization).toBe("Bearer secret-token");
    expect(seen[0]?.headers.accept).toBe("application/json");
  });

  test("keeps caller headers, method and body", async () => {
    seen.length = 0;
    const response = await transport().send("/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ input: "hi" }),
    }, "mutation");
    await response.body?.cancel();
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
    expect(seen[0]?.headers.accept).toBe("text/event-stream");
    expect(seen[0]?.body).toBe('{"input":"hi"}');
  });

  test("never follows a redirect", async () => {
    const response = await transport().send("/redirect", {}, "safe");
    expect(response.status).toBe(302);
    await response.body?.cancel();
  });
});

describe("direct transport: delivery certainty", () => {
  test("a forbidden destination is refused before any send", async () => {
    const forbidden = transport({ endpoint: "https://127.0.0.1:8642", policy: { environment: "production" } });
    const error = await forbidden.send("/health", {}, "mutation").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HermesClientError);
    expect((error as HermesClientError).code).toBe("HERMES_DESTINATION_FORBIDDEN");
    expect((error as HermesClientError).status).toBe(403);
    expect((error as HermesClientError).requestDelivery).toBe("not_sent");
  });

  test("an invalid URL is refused before any send", async () => {
    const invalid = transport({ endpoint: "not a url", policy: { environment: "production" } });
    const error = await invalid.send("/health", {}, "safe").catch((caught: unknown) => caught);
    expect((error as HermesClientError).code).toBe("HERMES_URL_INVALID");
    expect((error as HermesClientError).status).toBe(400);
    expect((error as HermesClientError).requestDelivery).toBe("not_sent");
  });

  test("mTLS over cleartext HTTP is refused before any send", async () => {
    const mtls = transport({
      mtls: { cert: "cert", key: "key", ca: "ca" },
      policy: { environment: "development", insecureOrigins: new Set([new URL(endpoint).host]) },
    });
    seen.length = 0;
    const error = await mtls.send("/health", {}, "safe").catch((caught: unknown) => caught);
    expect((error as HermesClientError).code).toBe("HERMES_HTTPS_REQUIRED");
    expect((error as HermesClientError).requestDelivery).toBe("not_sent");
    expect(seen).toHaveLength(0);
  });

  test("an already aborted signal is not_sent", async () => {
    const controller = new AbortController();
    controller.abort("early");
    const error = await transport().send("/health", { signal: controller.signal }, "mutation")
      .catch((caught: unknown) => caught);
    expect((error as Error).name).toBe("AbortError");
    expect((error as { requestDelivery?: string }).requestDelivery).toBe("not_sent");
  });

  test("a connection failure is ambiguous for a mutation and unknown for a read", async () => {
    const closed = "http://127.0.0.1:1";
    const unreachable = transport({ endpoint: closed, policy: { environment: "test", testHttpUrl: closed } });
    const mutation = await unreachable.send("/v1/runs", { method: "POST" }, "mutation")
      .catch((caught: unknown) => caught);
    expect((mutation as HermesClientError).code).toBe("HERMES_UNREACHABLE");
    expect((mutation as HermesClientError).requestDelivery).toBe("ambiguous");
    const read = await unreachable.send("/health", {}, "safe").catch((caught: unknown) => caught);
    expect((read as HermesClientError).code).toBe("HERMES_UNREACHABLE");
    expect((read as HermesClientError).requestDelivery).toBeNull();
  });
});

describe("HermesClient over the direct transport", () => {
  test("prefixes /p/<slug> before every path", async () => {
    seen.length = 0;
    const client = new HermesClient({
      endpoint,
      token: "secret-token",
      policy: { environment: "test", testHttpUrl: endpoint },
      mtls: null,
      profile: "prod-1",
    });
    await client.probe();
    expect(seen.map((entry) => entry.path).sort()).toEqual(["/p/prod-1/health", "/p/prod-1/v1/capabilities"]);
  });

  test("refuses an invalid profile slug without sending anything", async () => {
    seen.length = 0;
    const client = new HermesClient({
      endpoint,
      token: "secret-token",
      policy: { environment: "test", testHttpUrl: endpoint },
      mtls: null,
      profile: "../etc",
    });
    await expect(client.probe()).rejects.toThrow(/slug/);
    expect(seen).toHaveLength(0);
  });

  test("delegates to an injected transport with the prefixed path and the request kind", async () => {
    const calls: Array<{ path: string; method: string; kind: HermesRequestKind }> = [];
    const fake: HermesTransport = {
      kind: "relay",
      async send(path, init, kind) {
        calls.push({ path, method: init.method ?? "GET", kind });
        if (path.endsWith("/v1/runs")) return Response.json({ run_id: "run_1" });
        return Response.json({ ok: true });
      },
    };
    const client = new HermesClient({ transport: fake, profile: "scout" });
    await client.probe();
    const runId = await client.createRun({ input: "hi", instructions: "", sessionId: "s1" });
    expect(runId).toBe("run_1");
    expect(calls).toEqual([
      { path: "/p/scout/health", method: "GET", kind: "safe" },
      { path: "/p/scout/v1/capabilities", method: "GET", kind: "safe" },
      { path: "/p/scout/v1/runs", method: "POST", kind: "mutation" },
    ]);
  });
});
