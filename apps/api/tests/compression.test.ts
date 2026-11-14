import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  COMPRESSION_THRESHOLD_BYTES,
  isCompressibleContentType,
  isUncompressedPath,
  responseCompression,
} from "../src/interfaces/http/compression";

/**
 * `bun test` at the root preloads happy-dom (`apps/console/test-setup.ts`), whose
 * `Request` applies the BROWSER rule: `Accept-Encoding` is a forbidden
 * header, silently dropped. A real HTTP client: mobile, curl, a
 * reverse proxy: obviously sends it. It is therefore set back on the instance to
 * test what the API actually sees, instead of testing happy-dom.
 */
function requestWithEncoding(path: string, accept: string | null = "gzip, deflate"): Request {
  const request = new Request(`http://api.test${path}`);
  const headers = new Headers(request.headers);
  if (accept === null) headers.delete("Accept-Encoding");
  else headers.set("Accept-Encoding", accept);
  Object.defineProperty(request, "headers", { value: headers, configurable: true });
  return request;
}

/** A realistic thread: several dozen KiB of highly repetitive JSON. */
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
  // A faithful replica of `/api/events`: the same headers as `event-routes.ts`,
  // and a stream that stays open until it is closed.
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
    // `app.request()` short-circuits the network: the body arrives as-is, so
    // it really is the gzip envelope that is decompressed here, not the HTTP client.
    const raw = await new Response(response.body!.pipeThrough(new DecompressionStream("gzip"))).json();
    const decoded = raw as { events: unknown[] };
    expect(decoded.events).toHaveLength(400);
  });

  test("le flux SSE n'est ni compressé ni bufferisé", async () => {
    const response = await app().request(requestWithEncoding("/api/events"));
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Content-Encoding")).toBeNull();
    // The route's anti-buffer headers survive the middleware.
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    // The body comes out in the clear: no gzip envelope in front of `data:`.
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
    expect(isUncompressedPath("/api/pro/billing/checkout")).toBe(true);
    expect(isUncompressedPath("/api/pro")).toBe(true);
    expect(isUncompressedPath("/api/project")).toBe(false);
    // A path that STARTS with the same text without being the excluded route stays
    // compressed: `/api/eventsomething` is not the stream.
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
