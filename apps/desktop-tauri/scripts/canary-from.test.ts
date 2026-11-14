import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveCanaryFrom } from "./canary-from";

const BETA = "https://releases.openedbot.app/desktop/solo/beta/latest.json";

describe("canary-from", () => {
  test("stable older than the release: the normal N-1 -> N update, default feed", () => {
    expect(resolveCanaryFrom({ release: "0.1.1", stable: "0.1.0" })).toEqual({ mode: "update", from: "0.1.0", feed: "" });
    // Numeric, not a string comparison: 0.10.0 is newer than 0.9.0.
    expect(resolveCanaryFrom({ release: "0.10.0", stable: "0.9.0" })).toEqual({ mode: "update", from: "0.9.0", feed: "" });
    expect(resolveCanaryFrom({ release: "1.1.4", stable: "1.1.3" })).toEqual({ mode: "update", from: "1.1.3", feed: "" });
  });

  test("stable on a higher number (renumbering): harness on the release, through the beta manifest", () => {
    const plan = resolveCanaryFrom({ release: "0.1.0", stable: "1.1.4" });
    expect(plan).toMatchObject({ mode: "renumbering", from: "0.1.0", feed: BETA });
    expect(plan.mode === "renumbering" && plan.notice).toContain("N-1 -> N update proof is skipped");
    expect(resolveCanaryFrom({ release: "0.9.0", stable: "0.10.0" })).toMatchObject({ mode: "renumbering", from: "0.9.0", feed: BETA });
  });

  test("stable already on the release: harness on its own stable feed", () => {
    const plan = resolveCanaryFrom({ release: "0.1.0", stable: "0.1.0" });
    expect(plan).toMatchObject({ mode: "renumbering", from: "0.1.0", feed: "" });
    expect(plan.mode === "renumbering" && plan.notice).toContain("already serves 0.1.0");
  });

  test("an explicit from_version must be older, and is never turned into the harness", () => {
    expect(resolveCanaryFrom({ release: "0.1.1", stable: "1.1.4", requested: "0.1.0" })).toEqual({ mode: "update", from: "0.1.0", feed: "" });
    expect(() => resolveCanaryFrom({ release: "0.1.0", stable: "", requested: "1.1.4" })).toThrow(/not older than 0\.1\.0/);
    expect(() => resolveCanaryFrom({ release: "0.1.0", stable: "", requested: "0.1.0" })).toThrow(/not older/);
  });

  test("the tag workflow resolves the release through this helper and hands its feed to the canary", () => {
    const workflow = readFileSync(path.resolve(import.meta.dir, "../../../.github/workflows/desktop-release.yml"), "utf8");
    expect(workflow).toContain('bun apps/desktop-tauri/scripts/canary-from.ts --release "$VERSION" "$@" --output "$GITHUB_OUTPUT"');
    expect(workflow).toContain("feed: ${{ needs.canary-from.outputs.feed }}");
    // No string comparison of versions left in the workflow.
    expect(workflow).not.toContain("sort -V");
  });

  test("anything but X.Y.Z is refused", () => {
    expect(() => resolveCanaryFrom({ release: "0.1.0", stable: "null" })).toThrow(/X\.Y\.Z/);
    expect(() => resolveCanaryFrom({ release: "0.1.0", stable: "" })).toThrow(/X\.Y\.Z/);
    expect(() => resolveCanaryFrom({ release: "0.1.0-test", stable: "0.0.9" })).toThrow(/X\.Y\.Z/);
  });
});
