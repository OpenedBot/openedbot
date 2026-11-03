import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  COMPRESSION_THRESHOLD_BYTES,
  isCompressibleContentType,
  isUncompressedPath,
  responseCompression,
} from "../src/interfaces/http/compression";

/**
 * `bun test` à la racine précharge happy-dom (`apps/console/test-setup.ts`), dont
 * le `Request` applique la règle NAVIGATEUR : `Accept-Encoding` est un en-tête
 * interdit, silencieusement retiré. Un client HTTP réel : mobile, curl, un
 * reverse proxy : l'envoie évidemment. On le repose donc sur l'instance pour
 * tester ce que l'API voit vraiment, au lieu de tester happy-dom.
 */
function requestWithEncoding(path: string, accept: string | null = "gzip, deflate"): Request {
  const request = new Request(`http://api.test${path}`);
  const headers = new Headers(request.headers);
  if (accept === null) headers.delete("Accept-Encoding");
  else headers.set("Accept-Encoding", accept);
  Object.defineProperty(request, "headers", { value: headers, configurable: true });
  return request;
}

/** Un fil réaliste : plusieurs dizaines de Kio de JSON très répétitif. */
function bigJson(): unknown {
  return {
    events: Array.from({ length: 400 }, (_, index) => ({
      cursor: index,
      runId: "11111111-2222-4333-8444-555555555555",
      type: "agent.message",
      payload: { text: "le compresseur adore les fils de conversation" },
      occurredAt: "2026-08-27T00:00:00.000Z",
    })),
  };
}

function app(): Hono {
  const routes = new Hono();
  routes.use("/api/*", responseCompression());
  routes.get("/api/threads/:id", (context) => context.json(bigJson()));
  routes.get("/api/auth/session", (context) => context.json({ csrfToken: "s".repeat(4096) }));
  routes.get("/api/attachments/:id", (context) =>
    context.body(new Uint8Array(4096), 200, { "Content-Type": "application/octet-stream" }));
  // Réplique fidèle de `/api/events` : mêmes en-têtes que `event-routes.ts`,
  // et un flux qui reste ouvert tant qu'on ne le ferme pas.
  routes.get("/api/events", () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${"x".repeat(8192)}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
  return routes;
}

describe("compression des réponses de l'API", () => {
  test("compresse un snapshot JSON volumineux", async () => {
    const response = await app().request(requestWithEncoding("/api/threads/t1"));
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    expect(response.headers.get("Vary")).toContain("Accept-Encoding");
    // `app.request()` court-circuite le réseau : le corps arrive tel quel, donc
    // c'est bien l'enveloppe gzip qu'on décompresse ici, pas le client HTTP.
    const raw = await new Response(response.body!.pipeThrough(new DecompressionStream("gzip"))).json();
    const decoded = raw as { events: unknown[] };
    expect(decoded.events).toHaveLength(400);
  });

  test("le flux SSE n'est ni compressé ni bufferisé", async () => {
    const response = await app().request(requestWithEncoding("/api/events"));
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Content-Encoding")).toBeNull();
    // Les en-têtes anti-buffer de la route survivent au middleware.
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    // Le corps sort en clair : pas d'enveloppe gzip devant `data:`.
    const first = await response.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toStartWith("data: ");
  });

  test("ne compresse ni le binaire ni les corps porteurs du jeton CSRF", async () => {
    const attachment = await app().request(requestWithEncoding("/api/attachments/a1"));
    expect(attachment.headers.get("Content-Encoding")).toBeNull();
    const session = await app().request(requestWithEncoding("/api/auth/session"));
    expect(session.headers.get("Content-Encoding")).toBeNull();
  });

  test("laisse le client sans Accept-Encoding recevoir du clair", async () => {
    const response = await app().request(requestWithEncoding("/api/threads/t1", null));
    expect(response.headers.get("Content-Encoding")).toBeNull();
  });

  test("les chemins exclus couvrent le préfixe, pas seulement l'égalité", () => {
    expect(isUncompressedPath("/api/events")).toBe(true);
    expect(isUncompressedPath("/api/auth/me")).toBe(true);
    expect(isUncompressedPath("/api/pro/staff/login")).toBe(true);
    expect(isUncompressedPath("/api/pro/staff/support/events")).toBe(true);
    expect(isUncompressedPath("/api/pro/staffing")).toBe(false);
    // Un chemin qui COMMENCE par le même texte sans être la route exclue reste
    // compressé : `/api/eventsomething` n'est pas le flux.
    expect(isUncompressedPath("/api/eventsomething")).toBe(false);
    expect(isUncompressedPath("/api/threads/x")).toBe(false);
  });

  test("la liste blanche des types accepte le JSON et refuse le flux", () => {
    expect(isCompressibleContentType("application/json; charset=UTF-8")).toBe(true);
    expect(isCompressibleContentType("application/problem+json")).toBe(true);
    expect(isCompressibleContentType("text/event-stream")).toBe(false);
    expect(isCompressibleContentType("image/png")).toBe(false);
    expect(isCompressibleContentType(null)).toBe(false);
    expect(COMPRESSION_THRESHOLD_BYTES).toBe(1024);
  });
});
