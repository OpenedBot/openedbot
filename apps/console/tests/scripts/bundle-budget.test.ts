import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { measure } from "../../scripts/bundle-budget";

let dist = "";
afterEach(() => { if (dist) rmSync(dist, { recursive: true, force: true }); });

function build(html: string, files: Record<string, string>): string {
  dist = mkdtempSync(join(tmpdir(), "bundle-budget-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), html);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dist, "assets", name), body);
  return dist;
}

/** Random text: gzip cannot shrink it, so sizes stay predictable. */
const noise = (bytes: number) => Array.from({ length: bytes }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join("");

describe("budget du bundle", () => {
  test("entrée, préchargements et le plus gros dictionnaire, une seule fois chacun", () => {
    const files = { "index.js": noise(4096), "vendor.js": noise(8192), "fr.js": noise(2048), "en.js": noise(1024) };
    const dir = build(
      `<script>var files = {"en":"/assets/en.js","fr":"/assets/fr.js"};</script>
       <script type="module" crossorigin src="/assets/index.js"></script>
       <link rel="modulepreload" crossorigin href="/assets/vendor.js">
       <link rel="modulepreload" crossorigin href="/assets/vendor.js">`,
      files,
    );
    const kb = (name: keyof typeof files) => gzipSync(files[name], { level: 9 }).length / 1024;
    const result = measure(dir);
    expect(result.entry.file).toBe("assets/index.js");
    expect(result.firstLoad.files.sort()).toEqual(["assets/fr.js", "assets/index.js", "assets/vendor.js"]);
    // The preload listed twice counts once; English, the smaller dictionary, not at all.
    expect(result.firstLoad.kb).toBeCloseTo(kb("index.js") + kb("vendor.js") + kb("fr.js"), 6);
    expect(result.entry.kb).toBeCloseTo(kb("index.js"), 6);
  });

  test("sans dictionnaire préchargé, le budget refuse de compter à moitié", () => {
    const dir = build(`<script type="module" src="/assets/index.js"></script>`, { "index.js": "x" });
    expect(() => measure(dir)).toThrow(/no dictionary/);
  });

  test("sans entrée, une erreur nommée", () => {
    const dir = build(`<html></html>`, {});
    expect(() => measure(dir)).toThrow(/no module entry/);
  });
});
