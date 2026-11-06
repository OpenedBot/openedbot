import { describe, expect, test } from "bun:test";
import { buildManifest, feedFile } from "./update-feed";

describe("update feed", () => {
  test("the manifest has the static format of tauri-plugin-updater", () => {
    const manifest = buildManifest({
      version: "0.0.2",
      url: "http://127.0.0.1:8799/0.0.2/openedbot-preview_0.0.2_aarch64.app.tar.gz",
      signature: "  dW50cnVzdGVk\n",
      notes: "n",
      pubDate: new Date("2026-11-06T12:00:00Z"),
    });
    expect(manifest).toEqual({
      version: "0.0.2",
      notes: "n",
      pub_date: "2026-11-06T12:00:00.000Z",
      platforms: { "darwin-aarch64": { signature: "dW50cnVzdGVk", url: "http://127.0.0.1:8799/0.0.2/openedbot-preview_0.0.2_aarch64.app.tar.gz" } },
    });
  });

  test("a version or signature that cannot be served is refused", () => {
    const base = { url: "u", notes: "", pubDate: new Date() };
    expect(() => buildManifest({ ...base, version: "v1", signature: "s" })).toThrow();
    expect(() => buildManifest({ ...base, version: "0.0.2", signature: " " })).toThrow();
  });

  test("the server only serves files inside the feed", () => {
    expect(feedFile("/feed", "/latest.json")).toBe("/feed/latest.json");
    expect(feedFile("/feed", "/0.0.2/openedbot-preview_0.0.2_aarch64.app.tar.gz")).toBe("/feed/0.0.2/openedbot-preview_0.0.2_aarch64.app.tar.gz");
    for (const refused of ["/../secret", "/%2e%2e/secret", "/a/../../b", "/x y", "/%ZZ", "/"]) expect(feedFile("/feed", refused)).toBeNull();
  });
});
