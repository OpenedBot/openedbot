import { createHash } from "node:crypto";
import type { Plugin } from "vite";

/**
 * The console's Content-Security-Policy, set INSIDE the build: a
 * `<meta http-equiv>` tag at the head of `index.html`. It therefore travels with the
 * file, identical behind any static server or reverse proxy that serves the
 * build and in the desktop app's window, with no hash list to copy into each
 * server.
 *
 * Why it matters: in the desktop app, every script on the page reaches
 * `window.__OPENEDBOT_NATIVE__.readAccessToken()`. A script injection would mean
 * session theft; `script-src` admits only the site's files, the startup
 * inline scripts by their hash and the external scripts declared
 * in `index.html` (the audience measurement).
 *
 * What a meta tag does not carry (`frame-ancestors`, `sandbox`,
 * `report-uri`) goes in the HTTP header, from the server that serves the page.
 *
 * At build only: Vite's dev server injects its own inline
 * scripts (the React Refresh preamble) that no hash would cover.
 */

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const EXTERNAL_SCRIPT = /<script\b[^>]*\bsrc="(https?:\/\/[^"]+)"/gi;

function sha256(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

function origins(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") out.add(url.origin);
    } catch {
      // Not an absolute URL: nothing to allow.
    }
  }
  return [...out].sort();
}

/**
 * The API origin in the Tauri desktop app's policy
 * (`VITE_OPENEDBOT_SHELL=tauri`): a runtime setting over there, not a build one.
 * The shell replaces this marker when serving `index.html` (`src-tauri/src/csp.rs`,
 * same name); the two move together.
 */
export const DESKTOP_API_ORIGIN_PLACEHOLDER = "__OPENEDBOT_DESKTOP_API_ORIGIN__";

/**
 * Tauri's IPC: `ipc://localhost` on macOS and Linux, `http://ipc.localhost`
 * on Windows. Without them, Tauri falls back to `postMessage`, slower.
 */
const TAURI_IPC = ["ipc:", "http://ipc.localhost"];

/** The audience-measurement script: left out of the desktop build. */
const ANALYTICS_SCRIPT = /\s*<!-- Mesure d'audience[^>]*-->\s*<script\b[^>]*\bsrc="https:\/\/umami\.[^"]+"[^>]*><\/script>/;

export function withoutAnalytics(html: string): string {
  const stripped = html.replace(ANALYTICS_SCRIPT, "");
  if (new RegExp(EXTERNAL_SCRIPT.source, "i").test(stripped)) {
    throw new Error("index.html du build desktop : un script externe reste après le retrait de la mesure d'audience");
  }
  return stripped;
}

/**
 * The policy for this HTML. `apiOrigin`: `VITE_API_ORIGIN` when the console
 * calls an API on another name; empty, the API is on the page's name.
 * `desktop`: the console embedded in the Tauri app, served from the local
 * origin, which talks to the API chosen at runtime and to the shell over IPC.
 */
export function consolePolicy(html: string, apiOrigin = "", options: { desktop?: boolean } = {}): string {
  const hashes = [...html.matchAll(INLINE_SCRIPT)].map((match) => sha256(match[1] ?? "")).sort();
  const scriptOrigins = origins([...html.matchAll(EXTERNAL_SCRIPT)].map((match) => match[1] ?? ""));
  const api = options.desktop ? [DESKTOP_API_ORIGIN_PLACEHOLDER] : origins(apiOrigin ? [apiOrigin] : []);
  const ipc = options.desktop ? TAURI_IPC : [];
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", ...hashes, ...scriptOrigins]],
    // The startup skeleton's `style` attributes and the <style>
    // tag of the same block; interface libraries set some too.
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // Attachments and bot faces arrive as blob: (read with
    // the authentication header, never through a token URL).
    ["img-src", ["'self'", "data:", "blob:", ...api]],
    ["font-src", ["'self'", "data:"]],
    // Audience measurement sends its measurements to the name that serves its script.
    ["connect-src", ["'self'", ...ipc, ...api, ...scriptOrigins]],
    ["media-src", ["'self'", "data:", "blob:", ...api]],
    // A bot HTML document's preview is a sandboxed srcdoc: it inherits
    // this policy, so its scripts do not run there (intended, see
    // `attachment-canvas.tsx`). No other origin is framed here.
    ["frame-src", ["'self'"]],
    ["worker-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/** Inserts the tag right after `<head>`, before any script it must cover. */
export function injectPolicy(html: string, policy: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (!head) throw new Error("index.html sans <head> : la CSP ne peut pas être posée");
  const tag = `\n    <meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}" />`;
  const at = head.index + head[0].length;
  return html.slice(0, at) + tag + html.slice(at);
}

export function contentSecurityPolicy(): Plugin {
  let apiOrigin = "";
  let desktop = false;
  return {
    name: "openedbot-console-csp",
    apply: "build",
    configResolved(config) {
      apiOrigin = String(config.env.VITE_API_ORIGIN ?? "").trim();
      desktop = config.env.VITE_OPENEDBOT_SHELL === "tauri";
      if (desktop && apiOrigin) throw new Error("VITE_API_ORIGIN n'a pas de sens dans le build desktop : l'origine de l'API y est choisie à l'exécution");
    },
    transformIndexHtml: {
      // After the other plugins: the hashes cover the final HTML.
      order: "post",
      handler: (html) => {
        const page = desktop ? withoutAnalytics(html) : html;
        return injectPolicy(page, consolePolicy(page, apiOrigin, { desktop }));
      },
    },
  };
}
