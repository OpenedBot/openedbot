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

  test("a Linux manifest names the AppImage, so a deb install finds nothing to replace itself with", () => {
    const manifest = buildManifest({
      version: "1.1.1-test",
      url: "http://127.0.0.1:8799/1.1.1-test/openedbot-preview_1.1.1-test_x86_64.AppImage",
      signature: "c2ln",
      notes: "",
      pubDate: new Date("2026-11-06T12:00:00Z"),
      platform: "linux-x86_64",
    });
    expect(Object.keys(manifest.platforms)).toEqual(["linux-x86_64-appimage"]);
    expect(manifest.version).toBe("1.1.1-test");
  });

  test("the floor travels in the manifest only when set", () => {
    const base = { version: "0.0.18", url: "u", signature: "s", notes: "", pubDate: new Date("2026-11-06T12:00:00Z") };
    expect(buildManifest({ ...base, minVersion: "0.0.17", maxAgeDays: 30 })).toMatchObject({ min_version: "0.0.17", max_age_days: 30 });
    expect("min_version" in buildManifest(base)).toBe(false);
    expect(() => buildManifest({ ...base, minVersion: "soon" })).toThrow();
    expect(() => buildManifest({ ...base, maxAgeDays: 0 })).toThrow();
  });

  test("a version or signature that cannot be served is refused", () => {
    const base = { url: "u", notes: "", pubDate: new Date() };
    expect(() => buildManifest({ ...base, version: "v1", signature: "s" })).toThrow();
    expect(() => buildManifest({ ...base, version: "0.0.2", signature: " " })).toThrow();
    expect(() => buildManifest({ ...base, version: "1.1.1-", signature: "s" })).toThrow();
  });

  test("the server only serves files inside the feed", () => {
    expect(feedFile("/feed", "/latest.json")).toBe("/feed/latest.json");
    expect(feedFile("/feed", "/0.0.2/openedbot-preview_0.0.2_aarch64.app.tar.gz")).toBe("/feed/0.0.2/openedbot-preview_0.0.2_aarch64.app.tar.gz");
    for (const refused of ["/../secret", "/%2e%2e/secret", "/a/../../b", "/x y", "/%ZZ", "/"]) expect(feedFile("/feed", refused)).toBeNull();
  });
});
