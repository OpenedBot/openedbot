import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RELAY_PROTOCOL } from "../src/index";

// Structural checks on the normative fixtures and on the spec metadata, so a
// sync that breaks the files or forgets the version bump fails here.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

type Vector = { name?: unknown; frame?: unknown; valid?: unknown; binary?: unknown };
type Route = { method?: unknown; path?: unknown; events?: unknown; host?: unknown };

describe("relay-frames.vectors.json schema", () => {
  const vectors = JSON.parse(read("../fixtures/relay-frames.vectors.json")) as Vector[];

  test("is a non-empty array of vectors with unique names", () => {
    expect(Array.isArray(vectors)).toBe(true);
    expect(vectors.length).toBeGreaterThan(0);
    const names = vectors.map((v) => v.name);
    for (const name of names) expect(typeof name).toBe("string");
    expect(new Set(names).size).toBe(names.length);
  });

  test("each vector is either a text frame with a verdict or a binary frame", () => {
    for (const v of vectors) {
      const isText = v.frame !== undefined;
      const isBinary = v.binary !== undefined;
      expect(isText !== isBinary).toBe(true);
      if (isText) expect(typeof v.valid).toBe("boolean");
      if (isBinary) {
        const b = v.binary as { id?: unknown; chunk?: unknown; hex?: unknown };
        expect(Number.isInteger(b.id)).toBe(true);
        expect(typeof b.chunk).toBe("string");
        expect(b.hex).toMatch(/^([0-9a-f]{2})+$/);
      }
    }
  });

  test("covers both accepted and refused frames", () => {
    expect(vectors.some((v) => v.valid === true)).toBe(true);
    expect(vectors.some((v) => v.valid === false)).toBe(true);
  });
});

describe("relay-allowlist.json schema", () => {
  const routes = JSON.parse(read("../fixtures/relay-allowlist.json")) as Route[];

  test("every route has a method, an anchored regex and two flags", () => {
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      expect(["GET", "POST", "PUT", "PATCH", "DELETE"]).toContain(r.method as string);
      expect(typeof r.path).toBe("string");
      const path = r.path as string;
      expect(path.startsWith("^/")).toBe(true);
      expect(path.endsWith("$")).toBe(true);
      expect(() => new RegExp(path)).not.toThrow();
      expect(typeof r.events).toBe("boolean");
      expect(typeof r.host).toBe("boolean");
    }
  });

  test("has no duplicate route", () => {
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("spec metadata", () => {
  const spec = read("../../SPEC.md");
  const changelog = read("../../CHANGELOG.md");
  const pkg = JSON.parse(read("../../package.json")) as { version: string };

  test("SPEC.md, CHANGELOG.md and package.json agree on the spec version", () => {
    const m = spec.match(/Specification version \| \*\*(\d+\.\d+\.\d+)\*\*/);
    expect(m?.[1]).toBe(pkg.version);
    expect(changelog).toContain(`## [${pkg.version}]`);
  });

  test("SPEC.md states the wire protocol number implemented by the codec", () => {
    expect(spec).toContain(`\`protocol: ${RELAY_PROTOCOL}\``);
  });
});
