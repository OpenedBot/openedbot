import { compress } from "hono/compress";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../../routes/identity/auth";

/**
 * Below this threshold, the `Content-Encoding` header and the pass through
 * `CompressionStream` cost more than the bytes saved. This is Hono's default,
 * kept here so that it is readable and testable.
 *
 * It applies ONLY if the response already carries a `Content-Length`: Hono does not
 * buffer a body of unknown size in order to measure it, and that is the right
 * choice: measuring would mean waiting for the end of the body before emitting. A
 * small response without `Content-Length` therefore still goes through the
 * compressor; the cost is on the order of a microsecond, the only alternative
 * was to break streaming.
 */
export const COMPRESSION_THRESHOLD_BYTES = 1024;

/**
 * The body types the API has reason to compress: its contract responses
 * (JSON) and the rare text bodies. Everything else: binary attachments,
 * images, and above all `text/event-stream`: is left intact.
 *
 * Allowlist, not denylist: a new body type is never
 * compressed by accident; it has to be added here knowingly.
 */
export function isCompressibleContentType(header: string | null): boolean {
  if (!header) return false;
  const type = header.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json") ||
    type === "text/plain" || type === "text/markdown";
}

/**
 * The paths whose response must NEVER go through a compressor.
 *
 * - `/api/events` is the SSE stream: gzip writes in blocks, so an event
 *   would stay stuck in the compressor until the next block. On a stream
 *   held open for minutes, that means deltas that arrive in a batch
 *   instead of arriving as they come: exactly what the stream exists to
 *   avoid. The route already sets `Cache-Control: no-transform` and a
 *   `Content-Type` outside the allowlist: this exclusion by path is the
 *   third guard, the one that does not depend on what the route emits.
 * - `/internal/runtime-links/*` is the connector-link relay toward the
 *   worker: it carries gateway SSE streams and binary bodies in
 *   both directions. It is not mounted under `/api/*`, so never compressed
 *   today; the exclusion by path guarantees it whatever the mount.
 * - `/api/auth/*` carries the CSRF token in the JSON body (`csrfToken`).
 *   Compressing a response that mixes a secret and a controllable input is
 *   the BREACH configuration; these bodies are a few hundred bytes,
 *   nothing is lost by leaving them in the clear.
 * - `/api/pro/*` (the plug-in mounts) may carry a stream or a CSRF token
 *   next to controllable input; the core does not know which, so none is compressed.
 */
export function isUncompressedPath(path: string): boolean {
  return path === "/api/events" || path.startsWith("/api/events/") ||
    path === "/internal/runtime-links" || path.startsWith("/internal/runtime-links/") ||
    path === "/api/auth" || path.startsWith("/api/auth/") ||
    path === "/api/pro" || path.startsWith("/api/pro/");
}

/**
 * gzip/deflate on the API's JSON responses, never on the SSE stream.
 *
 * The exclusion is done BEFORE `next()`: the compressor is not even mounted
 * on the excluded path, so no future version of Hono can decide
 * to wrap the stream despite its `Content-Type`.
 */
export function responseCompression(): MiddlewareHandler<{ Variables: AppVariables }> {
  const gzip = compress({
    threshold: COMPRESSION_THRESHOLD_BYTES,
    contentTypeFilter: (type) => isCompressibleContentType(type),
  });
  return async (context, next) => {
    if (isUncompressedPath(context.req.path)) return next();
    return gzip(context, next);
  };
}
