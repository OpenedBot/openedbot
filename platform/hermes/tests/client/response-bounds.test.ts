import { describe, expect, test } from "bun:test";
import { HermesClient } from "../../src/client";
import { createHermesClientContext, DEFAULT_JSON_BODY_BYTES, type HermesClientContext } from "../../src/client/context";
import { resolveHermesTimeouts } from "../../src/client/timeouts";
import { MAX_SESSION_MESSAGES_BODY_BYTES } from "../../src/contracts";
import { HermesClientError } from "../../src/errors";
import type { HermesTransport } from "../../src/transport/types";

/**
 * Bornes des réponses lues au runtime : toute lecture JSON a un plafond, et
 * le délai d'une route hôte couvre le corps, pas seulement les en-têtes.
 */

function contextOver(transport: HermesTransport): HermesClientContext {
  const build = (profile: string | null): HermesClientContext => createHermesClientContext({
    config: { transport, profile },
    transport,
    timeouts: resolveHermesTimeouts(undefined),
    withProfile: build,
  });
  return build(null);
}

/** Un corps en flux, sans `Content-Length`, de `total` octets JSON valides. */
function streamedJson(prefix: string, total: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const head = encoder.encode(prefix);
  const tail = encoder.encode("\"]}");
  let remaining = total - head.byteLength - tail.byteLength;
  let sentHead = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentHead) {
        sentHead = true;
        controller.enqueue(head);
        return;
      }
      if (remaining > 0) {
        const size = Math.min(remaining, 64 * 1024);
        remaining -= size;
        controller.enqueue(encoder.encode("x".repeat(size)));
        return;
      }
      controller.enqueue(tail);
      controller.close();
    },
  });
}

/** En-têtes envoyés, premier octet du JSON, puis plus rien. */
function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
  });
}

describe("json() : lecture toujours bornée", () => {
  test("une route sans borne déclarée refuse un corps en flux au-delà de la borne par défaut", async () => {
    let read = 0;
    const transport: HermesTransport = {
      kind: "direct",
      send: async () => {
        const source = streamedJson("{\"data\":[\"", DEFAULT_JSON_BODY_BYTES * 4);
        const reader = source.getReader();
        // Compte ce que le client tire vraiment : il doit s'arrêter peu après la borne.
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) return controller.close();
            read += value.byteLength;
            controller.enqueue(value);
          },
          cancel: (reason) => reader.cancel(reason),
        }), { headers: { "content-type": "application/json" } });
      },
    };
    const error = await new HermesClient({ transport }).modelOptions().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HermesClientError);
    expect((error as HermesClientError).code).toBe("HERMES_RESPONSE_INVALID");
    expect((error as HermesClientError).message).toContain("trop volumineux");
    expect(read).toBeLessThan(DEFAULT_JSON_BODY_BYTES + 128 * 1024);
  });

  test("un Content-Length annoncé au-delà de la borne est refusé sans lire le corps", async () => {
    const transport: HermesTransport = {
      kind: "direct",
      send: async () => new Response("{}", { headers: { "content-length": String(DEFAULT_JSON_BODY_BYTES + 1) } }),
    };
    const error = await new HermesClient({ transport }).models().catch((caught: unknown) => caught);
    expect((error as HermesClientError).code).toBe("HERMES_RESPONSE_INVALID");
    expect((error as HermesClientError).message).toContain("trop volumineux");
  });

  test("une route qui déclare une borne plus large la garde (transcript de session)", async () => {
    const size = DEFAULT_JSON_BODY_BYTES + 256 * 1024;
    expect(size).toBeLessThan(MAX_SESSION_MESSAGES_BODY_BYTES);
    const transport: HermesTransport = {
      kind: "direct",
      send: async () => new Response(streamedJson("{\"data\":[\"", size)),
    };
    const messages = await new HermesClient({ transport }).sessionMessages("openedbot:org:thread");
    expect(messages).toHaveLength(1);
  });
});

describe("hostRequest : le délai couvre le corps", () => {
  test("un hôte qui suspend son corps après les en-têtes échoue au délai, et le signal part", async () => {
    let signal: AbortSignal | undefined;
    const transport: HermesTransport = {
      kind: "relay",
      send: async (_path, init) => {
        signal = init.signal ?? undefined;
        return new Response(stalledBody(), { headers: { "content-type": "application/json" } });
      },
    };
    const ctx = contextOver(transport);
    const response = await ctx.hostRequest("/hermes-setup/toolsets", { method: "GET" }, "safe", 30);
    const outcome = await Promise.race([
      ctx.providerJson(response).catch((caught: unknown) => caught),
      Bun.sleep(1_000).then(() => "still waiting" as const),
    ]);
    expect(outcome).toBeInstanceOf(HermesClientError);
    expect(outcome).toMatchObject({ status: 504, code: "HERMES_UNREACHABLE", requestDelivery: "response_received" });
    expect(signal?.aborted).toBe(true);
  });

  test("un corps lu en entier avant l'échéance désarme le délai", async () => {
    let signal: AbortSignal | undefined;
    const transport: HermesTransport = {
      kind: "relay",
      send: async (_path, init) => {
        signal = init.signal ?? undefined;
        return Response.json({ features: ["provider_management"] });
      },
    };
    const ctx = contextOver(transport);
    const response = await ctx.hostRequest("/hermes-setup/capabilities", { method: "GET" }, "safe", 30);
    expect(await ctx.providerJson(response)).toEqual({ features: ["provider_management"] });
    await Bun.sleep(60);
    expect(signal?.aborted).toBe(false);
  });

  test("un corps annulé par l'appelant désarme le délai", async () => {
    let signal: AbortSignal | undefined;
    const transport: HermesTransport = {
      kind: "relay",
      send: async (_path, init) => {
        signal = init.signal ?? undefined;
        return new Response(stalledBody(), { status: 404 });
      },
    };
    const ctx = contextOver(transport);
    const response = await ctx.hostRequest("/hermes-setup/capabilities", { method: "GET" }, "safe", 30);
    await response.body?.cancel();
    await Bun.sleep(60);
    expect(signal?.aborted).toBe(false);
  });
});
