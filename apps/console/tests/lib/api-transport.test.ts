import { afterEach, describe, expect, test } from "bun:test";
import { request } from "../../src/lib/api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("décodage des réponses", () => {
  test("un 200 dont le corps est une page HTML est une erreur de protocole, pas null", async () => {
    globalThis.fetch = (async () => new Response("<html>proxy</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(request("/api/groups/g-1", { method: "DELETE" })).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 200 });
  });

  test("un JSON tronqué aussi", async () => {
    globalThis.fetch = (async () => new Response("{\"bots\": [", { status: 200 })) as unknown as typeof fetch;
    await expect(request("/api/bots")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test("204 et corps vide restent des réponses sans contenu", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await expect(request("/api/x", { method: "POST" })).resolves.toBeUndefined();
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    await expect(request("/api/x", { method: "POST" })).resolves.toBeNull();
  });

  test("un refus au corps illisible garde la phrase de son statut", async () => {
    globalThis.fetch = (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;
    await expect(request("/api/bots")).rejects.toMatchObject({ status: 502 });
  });
});

describe("échéance des appels", () => {
  test("une connexion qui ne répond jamais finit en API_TIMEOUT, et la requête est annulée", async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
    await expect(request("/api/auth/me", undefined, { timeoutMs: 20 })).rejects.toMatchObject({ code: "API_TIMEOUT" });
    expect(signal?.aborted).toBe(true);
  });

  test("l'échéance couvre la lecture du corps", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{\"partial\":"));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    await expect(request("/api/bots", undefined, { timeoutMs: 20 })).rejects.toMatchObject({ code: "API_TIMEOUT" });
  });

  test("une écriture sans réponse le dit : elle a peut-être abouti", async () => {
    window.localStorage.setItem("ohb:locale", "fr");
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
    await expect(request("/api/bots", { method: "POST" }, { timeoutMs: 20 })).rejects.toMatchObject({
      code: "API_TIMEOUT",
      message: expect.stringContaining("peut-être abouti"),
    });
  });
});
