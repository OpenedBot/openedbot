import { afterEach, describe, expect, test } from "bun:test";
import type { SupportEventDto } from "@openedbot/contracts-api";
import { openSupportStream, supportBackoffMs } from "../../../src/lib/support/support-stream";

/**
 * Un flux qui rend ses trames puis RESTE OUVERT, comme un vrai SSE.
 *
 * Le refermer aussitôt faisait boucler la reconnexion sans jamais franchir de
 * macrotâche : le `setTimeout` de `settle()` était affamé et le test ne se
 * terminait pas. C'est exactement la boucle que `openSupportStream` doit
 * tenir en production, donc le faux doit se comporter comme la vraie route.
 */
function sse(...frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(": connected\n\n"));
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function frame(event: Partial<SupportEventDto> & { cursor: number }): string {
  const payload: SupportEventDto = {
    cursor: event.cursor,
    conversationId: event.conversationId ?? "conv-1",
    type: event.type ?? "support.message",
    payload: event.payload ?? { messageId: `m-${event.cursor}`, author: "staff", body: "on regarde" },
    occurredAt: event.occurredAt ?? "2026-09-12T08:00:00.000Z",
  };
  const id = event.cursor > 0 ? `id: ${event.cursor}\n` : "";
  return `${id}event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Laisse la boucle du flux tourner sans attendre un vrai délai. */
async function settle(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("le repli de reconnexion", () => {
  test("croît puis plafonne à cinq secondes", () => {
    expect(supportBackoffMs(1)).toBe(500);
    expect(supportBackoffMs(2)).toBe(1_000);
    expect(supportBackoffMs(5)).toBe(5_000);
    expect(supportBackoffMs(50)).toBe(5_000);
  });
});

describe("le flux du guichet côté visiteur", () => {
  test("porte le jeton et le curseur, et jamais dans l’URL pour le jeton", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const stream = openSupportStream({
      conversationId: "conv-1",
      token: "jeton-secret-de-plus-de-seize-caracteres",
      cursor: 7,
      handlers: { onEvent: () => {} },
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenHeaders = init.headers as Record<string, string>;
        return sse();
      }) as unknown as typeof fetch,
      wait: async () => {},
    });
    await settle();
    stream.close();
    expect(seenUrl).toContain("/api/support/conversations/conv-1/events?cursor=7");
    expect(seenUrl).not.toContain("jeton-secret");
    expect(seenHeaders["X-OHB-Support-Token"]).toBe("jeton-secret-de-plus-de-seize-caracteres");
    expect(seenHeaders["Last-Event-ID"]).toBe("7");
  });

  test("livre les trames du fil et jette celles d’un autre", async () => {
    const seen: number[] = [];
    const stream = openSupportStream({
      conversationId: "conv-1",
      token: "jeton-secret-de-plus-de-seize-caracteres",
      cursor: 0,
      handlers: { onEvent: (event) => seen.push(event.cursor) },
      fetchImpl: (async () => sse(
        frame({ cursor: 11 }),
        frame({ cursor: 12, conversationId: "conv-2" }),
        frame({ cursor: 13 }),
      )) as unknown as typeof fetch,
      wait: async () => {},
    });
    await settle();
    stream.close();
    expect(seen).toEqual([11, 13]);
  });

  test("ne recule jamais : une trame déjà vue est jetée", async () => {
    const seen: number[] = [];
    const stream = openSupportStream({
      conversationId: "conv-1",
      token: "jeton-secret-de-plus-de-seize-caracteres",
      cursor: 0,
      handlers: { onEvent: (event) => seen.push(event.cursor) },
      fetchImpl: (async () => sse(
        frame({ cursor: 11 }),
        frame({ cursor: 11 }),
        frame({ cursor: 10 }),
        frame({ cursor: 12 }),
      )) as unknown as typeof fetch,
      wait: async () => {},
    });
    await settle();
    stream.close();
    expect(seen).toEqual([11, 12]);
  });

  test("une trame de frappe passe sans toucher au curseur", async () => {
    const seen: SupportEventDto[] = [];
    const stream = openSupportStream({
      conversationId: "conv-1",
      token: "jeton-secret-de-plus-de-seize-caracteres",
      cursor: 20,
      handlers: { onEvent: (event) => seen.push(event) },
      fetchImpl: (async () => sse(
        frame({ cursor: 0, type: "support.typing", payload: { author: "staff" } }),
        frame({ cursor: 21 }),
        // Sans le traitement particulier du curseur zéro, cette seconde frappe
        // serait jetée par la comparaison de curseurs.
        frame({ cursor: 0, type: "support.typing", payload: { author: "staff" } }),
      )) as unknown as typeof fetch,
      wait: async () => {},
    });
    await settle();
    stream.close();
    expect(seen.map((event) => event.type)).toEqual([
      "support.typing",
      "support.message",
      "support.typing",
    ]);
  });

  test("un 401 ou un 404 arrête la boucle : insister ne rouvre pas une porte fermée", async () => {
    let attempts = 0;
    const statuses: boolean[] = [];
    const stream = openSupportStream({
      conversationId: "conv-1",
      token: "jeton-secret-de-plus-de-seize-caracteres",
      cursor: 0,
      handlers: { onEvent: () => {}, onStatus: (connected) => statuses.push(connected) },
      fetchImpl: (async () => {
        attempts += 1;
        return new Response(null, { status: 401 });
      }) as unknown as typeof fetch,
      wait: async () => {},
    });
    await settle();
    await settle();
    stream.close();
    expect(attempts).toBe(1);
    expect(statuses).toEqual([false]);
  });

  test("une panne réseau attend le repli, puis rouvre", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const seen: number[] = [];
    const stream = openSupportStream({
      conversationId: "conv-1",
      token: "jeton-secret-de-plus-de-seize-caracteres",
      cursor: 0,
      handlers: { onEvent: (event) => seen.push(event.cursor) },
      fetchImpl: (async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("réseau coupé");
        // Le second appel rend un flux qui reste ouvert : la boucle s'y
        // installe au lieu de reconnecter en rafale.
        return sse(frame({ cursor: 30 }));
      }) as unknown as typeof fetch,
      wait: async (ms) => {
        delays.push(ms);
        // Une vraie macrotâche : sans elle, la boucle de reconnexion affame
        // le minuteur de `settle` et le test ne rend jamais la main.
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    await settle();
    await settle();
    stream.close();
    expect(delays).toEqual([500]);
    expect(seen).toEqual([30]);
  });
});

describe("le flux du guichet dans la coque desktop", () => {
  afterEach(() => {
    delete window.__OHB_NATIVE__;
  });

  test("un compte sans jeton de guichet présente son Bearer, relu à chaque reconnexion", async () => {
    const tokens = ["acces-1", "acces-2"];
    window.__OHB_NATIVE__ = {
      readAccessToken: async () => tokens.shift() ?? null,
      refresh: async () => null,
      openExternal: async () => undefined,
      signOut: async () => undefined,
      shell: { platform: "windows", version: "1.0.0" },
    };
    const seen: Array<{ authorization: string | null; support: string | null; credentials?: RequestCredentials }> = [];
    let attempts = 0;
    const stream = openSupportStream({
      conversationId: "conv-1",
      token: null,
      cursor: 0,
      handlers: { onEvent: () => {} },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        seen.push({ authorization: headers.get("Authorization"), support: headers.get("X-OHB-Support-Token"), credentials: init.credentials });
        attempts += 1;
        if (attempts === 1) throw new Error("réseau coupé");
        return sse();
      }) as unknown as typeof fetch,
      wait: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    await settle();
    await settle();
    stream.close();
    expect(seen.map((call) => call.authorization)).toEqual(["Bearer acces-1", "Bearer acces-2"]);
    expect(seen.every((call) => call.support === null && call.credentials === "omit")).toBe(true);
  });
});
