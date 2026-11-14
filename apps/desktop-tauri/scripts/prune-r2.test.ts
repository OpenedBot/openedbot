import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { listObjects, planDesktopPrune, PruneRefused, type PruneInput, type R2Object } from "./prune-r2";
import { checksummed } from "./release";

/** A complete release: every file, SHA256SUMS uploaded last at `at`. */
function release(version: string, at: string): R2Object[] {
  const time = Date.parse(at);
  const before = Number.isFinite(time) ? new Date(time - 60_000).toISOString() : at;
  return [...checksummed(version).map((name) => ({ key: `desktop/v${version}/${name}`, last_modified: before })), { key: `desktop/v${version}/SHA256SUMS`, last_modified: at }];
}
const MANIFESTS: R2Object[] = [
  { key: "desktop/solo/beta/latest.json", last_modified: "2026-11-12T18:05:00Z" },
  { key: "desktop/solo/stable/latest.json", last_modified: "2026-11-12T18:05:00Z" },
];

function input(objects: R2Object[], stable: string, beta = stable): PruneInput {
  return { objects: [...MANIFESTS, ...objects], channels: { stable, beta } };
}

function refused(run: () => unknown, message: string): void {
  expect(run).toThrow(PruneRefused);
  expect(run).toThrow(message);
}

describe("planDesktopPrune", () => {
  test("normal case: the two newest publications stay, older ones go, SHA256SUMS first", () => {
    const plan = planDesktopPrune(input([...release("0.1.0", "2026-11-12T18:00:00Z"), ...release("0.1.1", "2026-11-14T10:00:00Z"), ...release("0.1.2", "2026-11-16T10:00:00Z")], "0.1.2"));
    expect(plan.keep).toEqual(["0.1.2", "0.1.1"]);
    expect(plan.remove).toEqual(["0.1.0"]);
    expect(plan.keys[0]).toBe("desktop/v0.1.0/SHA256SUMS");
    expect(plan.keys).toHaveLength(checksummed("0.1.0").length + 1);
    expect(plan.keys.every((key) => key.startsWith("desktop/v0.1.0/"))).toBe(true);
  });

  test("only two releases: nothing is deleted", () => {
    const plan = planDesktopPrune(input([...release("0.1.0", "2026-11-12T18:00:00Z"), ...release("1.1.4", "2026-11-10T09:00:00Z")], "1.1.4", "0.1.0"));
    expect(plan.remove).toEqual([]);
    expect(plan.keys).toEqual([]);
  });

  test("renumbering: 0.1.0, published after 1.1.4, is the newer one", () => {
    const plan = planDesktopPrune(input([...release("1.1.3", "2026-11-09T09:00:00Z"), ...release("1.1.4", "2026-11-10T09:00:00Z"), ...release("0.1.0", "2026-11-12T18:00:00Z")], "0.1.0"));
    expect(plan.releases.map((r) => r.version)).toEqual(["0.1.0", "1.1.4", "1.1.3"]);
    expect(plan.keep).toEqual(["0.1.0", "1.1.4"]);
    // By number alone 1.1.4 and 1.1.3 would stay and 0.1.0 would go.
    expect(plan.remove).toEqual(["1.1.3"]);
  });

  test("a manifest pointing at an old release keeps it (stable before promotion: the canary's N-1)", () => {
    const objects = [...release("1.1.4", "2026-11-10T09:00:00Z"), ...release("0.1.0", "2026-11-12T18:00:00Z"), ...release("0.1.1", "2026-11-14T10:00:00Z")];
    const plan = planDesktopPrune(input(objects, "1.1.4", "0.1.1"));
    expect(plan.keep).toEqual(["0.1.1", "0.1.0", "1.1.4"]);
    expect(plan.remove).toEqual([]);
    expect(planDesktopPrune(input(objects, "0.1.1", "1.1.4")).remove).toEqual([]);
  });

  test("unparsable directories are refused, solo/ and root files are ignored", () => {
    const objects = [...release("0.1.0", "2026-11-12T18:00:00Z"), ...release("1.1.4", "2026-11-10T09:00:00Z")];
    refused(() => planDesktopPrune(input([...objects, { key: "desktop/v0.2.0-beta/SHA256SUMS", last_modified: "2026-11-13T00:00:00Z" }], "0.1.0")), "unexpected directory");
    refused(() => planDesktopPrune(input([...objects, { key: "desktop/old/x", last_modified: "2026-11-13T00:00:00Z" }], "0.1.0")), "unexpected directory");
    refused(() => planDesktopPrune(input([...objects, { key: "desktop/v01.1.0/SHA256SUMS", last_modified: "2026-11-13T00:00:00Z" }], "0.1.0")), "unexpected directory");
    refused(() => planDesktopPrune(input([...objects, { key: "edge-setup/LATEST", last_modified: "2026-11-13T00:00:00Z" }], "0.1.0")), "outside desktop/");
    expect(planDesktopPrune(input([...objects, { key: "desktop/README", last_modified: "2026-11-13T00:00:00Z" }], "0.1.0")).remove).toEqual([]);
  });

  test("anything that looks wrong is refused rather than guessed", () => {
    const two = [...release("0.1.0", "2026-11-12T18:00:00Z"), ...release("1.1.4", "2026-11-10T09:00:00Z")];
    refused(() => planDesktopPrune(input(release("0.1.0", "2026-11-12T18:00:00Z"), "0.1.0")), "fewer than 2");
    // An upload in progress: files but no SHA256SUMS yet.
    const partial = release("0.1.1", "2026-11-14T10:00:00Z").filter((o) => !o.key.endsWith("/SHA256SUMS"));
    refused(() => planDesktopPrune(input([...two, ...partial], "0.1.0")), "no SHA256SUMS");
    refused(() => planDesktopPrune(input([...two, ...release("0.1.1", "not a date")], "0.1.0")), "unreadable date");
    refused(() => planDesktopPrune(input([...two, ...release("0.1.1", "2026-11-12T18:00:00Z")], "0.1.0")), "same instant");
    refused(() => planDesktopPrune(input(two, "0.0.9", "0.1.0")), "absent from the bucket");
    refused(() => planDesktopPrune(input(two, "", "0.1.0")), "names no release");
  });

  test("the recorded bucket of 2026-11-13: nothing to delete", () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures/r2-desktop-2026-11-13.json"), "utf8")) as PruneInput;
    const plan = planDesktopPrune(fixture);
    expect(plan.releases.map((r) => r.version)).toEqual(["0.1.0", "1.1.4"]);
    expect(plan.remove).toEqual([]);
  });
});

describe("listObjects", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function serve(pages: unknown[]): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
    }) as typeof fetch;
    return urls;
  }
  const api = { base: "https://api.example.test/objects", auth: "t" };

  test("reads every page through the cursor", async () => {
    const urls = serve([
      { success: true, result: [{ key: "desktop/v1/a", last_modified: "x" }], result_info: { is_truncated: true, cursor: "c 1" } },
      { success: true, result: [{ key: "desktop/v1/b", last_modified: "y" }], result_info: { is_truncated: false } },
    ]);
    expect((await listObjects(api, "desktop/")).map((o) => o.key)).toEqual(["desktop/v1/a", "desktop/v1/b"]);
    expect(urls[0]).toBe("https://api.example.test/objects?prefix=desktop%2F&per_page=1000");
    expect(urls[1]).toContain("cursor=c+1");
  });

  test("an error or a truncated page without a cursor refuses", async () => {
    serve([{ success: false, errors: [{ code: 10000, message: "Authentication error" }] }]);
    await expect(listObjects(api, "desktop/")).rejects.toThrow("listing desktop/ failed");
    serve([{ success: true, result: [], result_info: { is_truncated: true } }]);
    await expect(listObjects(api, "desktop/")).rejects.toThrow("truncated without a cursor");
  });
});
