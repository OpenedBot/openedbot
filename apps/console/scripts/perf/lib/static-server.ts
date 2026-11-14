// A static server for a console build that behaves like the production web
// server: gzip, ETag and Last-Modified,
// `Cache-Control: no-cache` on the document, 404 for a missing file,
// index.html for every other path, and `/api` proxied to the local API, SSE
// included. One gap: production marks hashed assets `immutable`, this server
// leaves them to the browser's heuristic freshness, so a relaunch here can
// only be as fast as production, never faster.
//
// The root can be swapped at runtime (`setRoot`) so a "first launch after a
// new build" is measured on the SAME origin: same localStorage and IndexedDB,
// new chunks, new build id.

import { existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { gzipSync } from "node:zlib";

const FILE_EXTENSIONS = new Set([".js", ".mjs", ".css", ".map", ".json", ".webmanifest", ".txt", ".xml", ".ico", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".woff", ".woff2", ".ttf", ".md", ".wasm"]);
const COMPRESSIBLE = new Set([".js", ".mjs", ".css", ".json", ".webmanifest", ".txt", ".xml", ".svg", ".md", ".html", ".map", ".wasm"]);

/**
 * Simulated network: every response waits one round trip, plus its body size
 * over the bandwidth for static files. Approximate on purpose: this server
 * speaks HTTP/1.1 (Chromium opens 6 connections per host), where production
 * sits behind HTTP/2 or HTTP/3, so many small chunks cost more here.
 */
export type NetworkProfile = { name: string; rttMs: number; mbps: number | null };
export const LOCAL: NetworkProfile = { name: "local", rttMs: 0, mbps: null };

export type StaticServer = { origin: string; setRoot(root: string): void; setNetwork(profile: NetworkProfile): void; stop(): void };

export function startStaticServer(options: { root: string; port: number; apiTarget: string }): StaticServer {
  let root = options.root;
  let network: NetworkProfile = LOCAL;
  const wait = async (bytes: number) => {
    const ms = network.rttMs + (network.mbps ? (bytes * 8) / (network.mbps * 1000) : 0);
    if (ms > 0) await Bun.sleep(ms);
  };
  const gzipCache = new Map<string, Uint8Array>();

  async function serveFile(path: string, request: Request): Promise<Response> {
    const stat = statSync(path);
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const lastModified = new Date(stat.mtimeMs).toUTCString();
    const headers = new Headers({ etag, "last-modified": lastModified, vary: "Accept-Encoding" });
    // The document is revalidated on every navigation, as production does.
    // Without this, Chromium reused build A's index.html after the swap to
    // build B (Last-Modified and no Cache-Control give the HTML a heuristic
    // lifetime): the "update" case measured build A.
    if (path.endsWith(".html")) headers.set("cache-control", "no-cache");
    const type = Bun.file(path).type;
    headers.set("content-type", type);
    if (request.headers.get("if-none-match") === etag) {
      await wait(0);
      return new Response(null, { status: 304, headers });
    }
    const extension = extname(path) || ".html";
    if (COMPRESSIBLE.has(extension) && /\bgzip\b/u.test(request.headers.get("accept-encoding") ?? "")) {
      const key = `${path}:${etag}`;
      let body = gzipCache.get(key);
      if (!body) {
        body = gzipSync(new Uint8Array(await Bun.file(path).arrayBuffer()), { level: 6 });
        gzipCache.set(key, body);
      }
      headers.set("content-encoding", "gzip");
      await wait(body.length);
      return new Response(body as Uint8Array<ArrayBuffer>, { headers });
    }
    await wait(stat.size);
    return new Response(Bun.file(path), { headers });
  }

  const server = Bun.serve({
    port: options.port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
        const target = new URL(url.pathname + url.search, options.apiTarget);
        const headers = new Headers(request.headers);
        headers.set("host", target.host);
        headers.delete("accept-encoding");
        const upstream = await fetch(target, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
          redirect: "manual",
          decompress: false,
        } as RequestInit);
        await wait(0);
        const out = new Headers(upstream.headers);
        out.delete("content-encoding");
        out.delete("content-length");
        return new Response(upstream.body, { status: upstream.status, headers: out });
      }
      const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/u, "");
      const candidate = join(root, relative);
      if (!candidate.startsWith(root)) return new Response("forbidden", { status: 403 });
      if (FILE_EXTENSIONS.has(extname(relative))) {
        return existsSync(candidate) && statSync(candidate).isFile() ? serveFile(candidate, request) : new Response("not found", { status: 404 });
      }
      if (existsSync(candidate) && statSync(candidate).isFile()) return serveFile(candidate, request);
      return serveFile(join(root, "index.html"), request);
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    setRoot(next) {
      root = next;
    },
    setNetwork(profile) {
      network = profile;
    },
    stop() {
      server.stop(true);
    },
  };
}
