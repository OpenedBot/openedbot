import { describe, expect, test } from "bun:test";
import { HermesClientError, RelayDialError } from "@openedbot/hermes";
import {
  createRuntimeClient,
  createWorkerRelayDialer,
  RELAY_STAGE_HEADER,
  relayProxyUrl,
  type RuntimeClientConfig,
  type RuntimeClientContext,
} from "../src/application/runtime-client";
const config: RuntimeClientConfig = {
  apiInternalUrl: "http://127.0.0.1:8790",
  apiInternalToken: "worker-internal-token",
};

function connectorContext(): RuntimeClientContext {
  return {
    runtimeId: "rt-connector",
    reachability: "connector",
    runtimeEndpoint: null,
    tokenCiphertext: null,
    tokenNonce: null,
    tokenTag: null,
    tokenKeyId: null,
    hermesProfile: null,
  };
}

describe("createRuntimeClient", () => {
  test("un runtime connector parle au relais interne, avec le bearer worker et sans bearer gateway", async () => {
    const seen: Array<{ url: string; method: string; headers: Headers }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      return Response.json({ ok: true, service: "fake" });
    }) as unknown as typeof fetch;
    const client = createRuntimeClient(connectorContext(), config, fetchImpl);
    await client.probe().catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.url.startsWith("http://127.0.0.1:8790/internal/runtime-links/rt-connector/proxy/")).toBe(true);
      expect(request.headers.get("Authorization")).toBe("Bearer worker-internal-token");
    }
  });

  test("le préfixe de profil traverse le relais dans le chemin", () => {
    expect(relayProxyUrl("http://127.0.0.1:8790/", "rt-1", "/p/scout/health"))
      .toBe("http://127.0.0.1:8790/internal/runtime-links/rt-1/proxy/p/scout/health");
  });
});

describe("createWorkerRelayDialer", () => {
  const dial = (response: Response | (() => Promise<Response>)) =>
    createWorkerRelayDialer("rt-1", config, (async () =>
      typeof response === "function" ? response() : response) as unknown as typeof fetch);

  test("une réponse marquée before_dispatch devient une RelayDialError classée not_sent", async () => {
    const response = Response.json(
      { error: { code: "RUNTIME_LINK_UNAVAILABLE", message: "lien fermé", stage: "before_dispatch" } },
      { status: 503, headers: { [RELAY_STAGE_HEADER]: "before_dispatch" } },
    );
    const error = await dial(response)({ method: "GET", path: "/health", headers: {}, body: null })
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(RelayDialError);
    expect((error as RelayDialError).stage).toBe("before_dispatch");
    expect((error as RelayDialError).code).toBe("RUNTIME_LINK_UNAVAILABLE");
  });

  test("une réponse marquée after_dispatch garde son étape : Hermes a peut-être agi", async () => {
    const response = Response.json(
      { error: { code: "LINK_TIMEOUT", message: "pas de réponse", stage: "after_dispatch" } },
      { status: 502, headers: { [RELAY_STAGE_HEADER]: "after_dispatch" } },
    );
    const error = await dial(response)({ method: "POST", path: "/v1/runs", headers: {}, body: null })
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(RelayDialError);
    expect((error as RelayDialError).stage).toBe("after_dispatch");
  });

  test("une réponse sans marque est la réponse du gateway, rendue telle quelle", async () => {
    const response = await dial(Response.json({ run_id: "run-1" }, { status: 201 }))({
      method: "POST",
      path: "/v1/runs",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ run_id: "run-1" });
  });

  test("le transport relay classe la panne du relais comme HERMES_UNREACHABLE", async () => {
    const client = createRuntimeClient(connectorContext(), config, (async () =>
      Response.json(
        { error: { code: "RUNTIME_LINK_UNAVAILABLE", message: "lien fermé", stage: "before_dispatch" } },
        { status: 503, headers: { [RELAY_STAGE_HEADER]: "before_dispatch" } },
      )) as unknown as typeof fetch);
    const error = await client.probe().then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(HermesClientError);
    expect((error as HermesClientError).code).toBe("HERMES_UNREACHABLE");
    expect((error as HermesClientError).requestDelivery).toBe("not_sent");
  });
});

test("dedicated gateway receives runtime calls while API origin remains available for events", async () => {
  const seen: string[] = [];
  const split = { ...config, runtimeLinkInternalUrl: "http://links:8792" };
  const dial = createWorkerRelayDialer("rt-1", split, (async (url: RequestInfo | URL) => {
    seen.push(String(url));
    return new Response("ok");
  }) as typeof fetch);
  await dial({ method: "GET", path: "/p/bot-1/v1/runs/run-1/events?since=7", headers: {}, body: null });
  expect(seen).toEqual(["http://links:8792/internal/runtime-links/rt-1/proxy/p/bot-1/v1/runs/run-1/events?since=7"]);
  expect(split.apiInternalUrl).toBe("http://127.0.0.1:8790");
});

test("only a proven connection failure is classified as not sent by the worker", async () => {
  const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
  const uncertain = new Error("unable to connect after dispatch");
  for (const failure of [refused, uncertain]) {
    const dial = createWorkerRelayDialer("rt-1", config, (async () => { throw failure; }) as unknown as typeof fetch);
    const result = await dial({ method: "POST", path: "/v1/runs", headers: {}, body: null }).catch((error: unknown) => error);
    if (failure === refused) {
      expect(result).toBeInstanceOf(RelayDialError);
      expect((result as RelayDialError).stage).toBe("before_dispatch");
    } else {
      expect(result).toBe(uncertain);
    }
  }
});
