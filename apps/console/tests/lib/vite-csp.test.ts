import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { consolePolicy, DESKTOP_API_ORIGIN_PLACEHOLDER, injectPolicy, withoutAnalytics } from "../../vite-csp";

const BOOT = "\n      document.documentElement.classList.add('x');\n    ";
const HTML = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <script defer src="https://umami.example.test/script.js" data-website-id="w"></script>
    <script>${BOOT}</script>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  </head>
  <body><script>window.y = 1;</script></body>
</html>`;

function directive(policy: string, name: string): string[] {
  const entry = policy.split("; ").find((part) => part.startsWith(`${name} `));
  return entry ? entry.split(" ").slice(1) : [];
}

const hash = (source: string) => `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;

describe("consolePolicy", () => {
  test("allows the site, each inline script by its exact hash and the declared external script", () => {
    const scripts = directive(consolePolicy(HTML), "script-src");
    expect(scripts).toContain("'self'");
    expect(scripts).toContain(hash(BOOT));
    expect(scripts).toContain(hash("window.y = 1;"));
    expect(scripts).toContain("https://umami.example.test");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });

  test("a changed inline script no longer matches", () => {
    const changed = HTML.replace("classList.add('x')", "classList.add('evil')");
    expect(directive(consolePolicy(changed), "script-src")).not.toContain(hash(BOOT));
  });

  test("closes plugins, foreign bases and foreign form targets", () => {
    const policy = consolePolicy(HTML);
    expect(directive(policy, "object-src")).toEqual(["'none'"]);
    expect(directive(policy, "base-uri")).toEqual(["'self'"]);
    expect(directive(policy, "form-action")).toEqual(["'self'"]);
    expect(directive(policy, "default-src")).toEqual(["'self'"]);
  });

  test("the analytics host may receive beacons; a split API origin joins connect, img and media", () => {
    expect(directive(consolePolicy(HTML), "connect-src")).toEqual(["'self'", "https://umami.example.test"]);
    const split = consolePolicy(HTML, "https://api.example.test/");
    expect(directive(split, "connect-src")).toContain("https://api.example.test");
    expect(directive(split, "img-src")).toContain("https://api.example.test");
    expect(directive(split, "media-src")).toContain("https://api.example.test");
  });

  test("frames: the site only (the HTML preview is a srcdoc, which inherits this policy)", () => {
    expect(directive(consolePolicy(HTML), "frame-src")).toEqual(["'self'"]);
  });
});

describe("injectPolicy", () => {
  test("puts the meta tag first in <head>, before every script it must cover", () => {
    const out = injectPolicy(HTML, consolePolicy(HTML));
    const meta = out.indexOf('http-equiv="Content-Security-Policy"');
    expect(meta).toBeGreaterThan(out.indexOf("<head>"));
    expect(meta).toBeLessThan(out.indexOf("<script"));
    expect(meta).toBeLessThan(out.indexOf('<meta charset="UTF-8" />'));
  });

  test("refuses a document without <head> rather than shipping it unprotected", () => {
    expect(() => injectPolicy("<html><body></body></html>", "default-src 'self'")).toThrow();
  });

  test("the real index.html keeps its boot scripts inline and covered", () => {
    const source = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    const scripts = directive(consolePolicy(source), "script-src");
    // Two inline boot scripts today; each must be hashed, none left out.
    const inline = [...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    expect(inline.length).toBeGreaterThan(0);
    for (const match of inline) expect(scripts).toContain(hash(match[1] ?? ""));
  });
});

describe("consolePolicy, desktop build (Tauri)", () => {
  const desktopHtml = HTML.replace(/\s*<script defer src="https:\/\/umami[^>]*><\/script>/, "");

  test("the runtime API origin is a placeholder the shell fills, next to the Tauri IPC", () => {
    const policy = consolePolicy(desktopHtml, "", { desktop: true });
    expect(directive(policy, "connect-src")).toEqual(["'self'", "ipc:", "http://ipc.localhost", DESKTOP_API_ORIGIN_PLACEHOLDER]);
    expect(directive(policy, "img-src")).toContain(DESKTOP_API_ORIGIN_PLACEHOLDER);
    expect(directive(policy, "media-src")).toContain(DESKTOP_API_ORIGIN_PLACEHOLDER);
    expect(directive(policy, "script-src")).toContain(hash(BOOT));
    expect(directive(policy, "script-src")).not.toContain("'unsafe-inline'");
  });

  test("the analytics script leaves the real index.html, and nothing external remains", () => {
    const real = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    expect(real).toContain("umami");
    const stripped = withoutAnalytics(real);
    expect(stripped).not.toContain("umami");
    expect(directive(consolePolicy(stripped, "", { desktop: true }), "script-src").some((source) => source.startsWith("https:"))).toBe(false);
    expect(() => withoutAnalytics(stripped.replace("</head>", '<script src="https://cdn.example.test/x.js"></script></head>'))).toThrow();
  });
});
