import { describe, expect, test } from "bun:test";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { assertPassword, boundedTextBody, jsonBody } from "../src/http-body";

/**
 * Un corps chunked, sans `Content-Length` : `chunks` blocs de `chunkSize`
 * octets, puis une attente sans fin. Le flux ne se ferme jamais tout seul :
 * seule une lecture qui annule à la borne peut rendre la main.
 */
function endlessChunkedRequest(chunkSize: number, chunks: number): { request: Request; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) return new Promise<void>(() => undefined);
      pulled += 1;
      controller.enqueue(new Uint8Array(chunkSize).fill(0x20));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://localhost/x", { method: "POST", body, duplex: "half" } as RequestInit);
  return { request, pulled: () => pulled, cancelled: () => cancelled };
}

async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | "still waiting"> {
  return Promise.race([promise, Bun.sleep(ms).then(() => "still waiting" as const)]);
}

describe("bornes de corps appliquées pendant la lecture du flux", () => {
  for (const [name, read] of [
    ["jsonBody", (request: Request, max: number) => jsonBody(request, max)],
    ["boundedTextBody", (request: Request, max: number) => boundedTextBody(request, max)],
  ] as const) {
    test(`${name} rend 413 dès le dépassement, sans attendre la fin du flux, et l'annule`, async () => {
      const { request, pulled, cancelled } = endlessChunkedRequest(1_024, 8);
      expect(request.headers.get("content-length")).toBeNull();
      const outcome = await settleWithin(read(request, 1_024).catch((error: unknown) => error), 1_000);
      expect(outcome).toBeInstanceOf(HttpError);
      expect(outcome).toMatchObject({ status: 413, code: "BODY_TOO_LARGE" });
      expect(pulled()).toBeLessThanOrEqual(3);
      expect(cancelled()).toBe(true);
    });
  }

  test("un corps sous la borne est lu entier, en plusieurs blocs", async () => {
    const encoder = new TextEncoder();
    const parts = ["{\"a\":", "\"", "x".repeat(500), "\"}"];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    });
    const request = new Request("http://localhost/x", { method: "POST", body, duplex: "half" } as RequestInit);
    expect(await jsonBody(request, 1_024)).toEqual({ a: "x".repeat(500) });
    expect(await boundedTextBody(new Request("http://localhost/x", { method: "POST", body: "é".repeat(10) }), 20)).toBe("é".repeat(10));
  });

  test("un corps exactement à la borne passe, un octet de plus est refusé", async () => {
    const exact = JSON.stringify({ a: "x".repeat(10) });
    expect(await jsonBody(new Request("http://localhost/x", { method: "POST", body: exact }), exact.length)).toEqual({ a: "x".repeat(10) });
    const over = await boundedTextBody(new Request("http://localhost/x", { method: "POST", body: `${exact} ` }), exact.length)
      .catch((error: unknown) => error);
    expect(over).toMatchObject({ status: 413, code: "BODY_TOO_LARGE" });
  });

  test("un corps vide reste un JSON invalide (400), un texte vide reste vide", async () => {
    const empty = await jsonBody(new Request("http://localhost/x", { method: "POST" })).catch((error: unknown) => error);
    expect(empty).toMatchObject({ status: 400, code: "INVALID_JSON" });
    expect(await boundedTextBody(new Request("http://localhost/x", { method: "POST" }))).toBe("");
  });
});

describe("assertPassword", () => {
  test("rend la saisie intacte, espaces de bord compris", () => {
    expect(assertPassword("  Correct-Horse-Battery ", "Le mot de passe")).toBe("  Correct-Horse-Battery ");
    expect(assertPassword(" ", "Le mot de passe")).toBe(" ");
  });

  test("refuse un type, une saisie vide ou une longueur hors borne", () => {
    for (const value of [undefined, 12, "", "x".repeat(1_025)]) {
      expect(() => assertPassword(value, "Le mot de passe")).toThrow(expect.objectContaining({ status: 400, code: "VALIDATION_ERROR" }));
    }
    expect(assertPassword("x".repeat(1_024), "Le mot de passe")).toHaveLength(1_024);
  });
});
