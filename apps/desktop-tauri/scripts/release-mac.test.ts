import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactNames, BUILD_VERSION, IDENTITIES, identityOverlay, mergeConfig, RELEASE_VERSION } from "./mac-identity";
import { hostedLayout, releaseManifest } from "./release-mac";
import { macArtifact } from "./update-feed";

const APP_DIR = path.resolve(import.meta.dir, "..");

describe("macOS release (D3)", () => {
  test("the production overlay is the identity the scripts expect", () => {
    const overlay = identityOverlay(APP_DIR, IDENTITIES.production);
    expect(overlay).toMatchObject({ identifier: "app.openedbot.desktop", productName: "openedbot", mainBinaryName: "openedbot" });
    expect((overlay.plugins as { "deep-link": { desktop: { schemes: string[] } } })["deep-link"].desktop.schemes).toEqual(["openedbot"]);
    expect(identityOverlay(APP_DIR, IDENTITIES.preview)).toEqual({});
  });

  test("the build overlay merges objects and replaces the rest", () => {
    const merged = mergeConfig(
      { identifier: "a", plugins: { "deep-link": { desktop: { schemes: ["openedbot"] } } }, bundle: { targets: ["app"] } },
      { version: "1.1.0", plugins: { updater: { pubkey: "k" } }, bundle: { targets: ["dmg"], macOS: {} } },
    );
    expect(merged).toEqual({
      identifier: "a",
      version: "1.1.0",
      plugins: { "deep-link": { desktop: { schemes: ["openedbot"] } }, updater: { pubkey: "k" } },
      bundle: { targets: ["dmg"], macOS: {} },
    });
  });

  test("test builds carry a suffix, releases never do", () => {
    expect(BUILD_VERSION.test("1.1.1-test")).toBe(true);
    expect(BUILD_VERSION.test("1.1.0")).toBe(true);
    expect(BUILD_VERSION.test("v1.1.0")).toBe(false);
    expect(RELEASE_VERSION.test("1.1.1-test")).toBe(false);
    expect(() => hostedLayout("1.1.1-test")).toThrow();
  });

  test("files live under an immutable version directory, manifests per variant and channel", () => {
    const layout = hostedLayout("1.1.0");
    expect(layout.dir).toBe("desktop/v1.1.0");
    expect(layout.manifest("beta")).toBe("desktop/solo/beta/latest.json");
    expect(layout.manifest("stable")).toBe("desktop/solo/stable/latest.json");
    const manifest = releaseManifest("1.1.0", "c2ln\n", "openedbot 1.1.0", new Date("2026-11-06T12:00:00Z"));
    expect(manifest.platforms).toEqual({
      "darwin-aarch64": { signature: "c2ln", url: "https://releases.openedbot.app/desktop/v1.1.0/openedbot_1.1.0_aarch64.app.tar.gz" },
    });
    expect(manifest.version).toBe("1.1.0");
    expect("min_version" in manifest).toBe(false);
  });

  test("the local feed finds a production build before a preview one", () => {
    const release = mkdtempSync(path.join(tmpdir(), "openedbot-release-"));
    try {
      mkdirSync(path.join(release, "1.1.1-test"));
      expect(macArtifact(release, "1.1.1-test")).toBe(path.join(release, "1.1.1-test", artifactNames(IDENTITIES.production, "1.1.1-test").tarball));
      writeFileSync(path.join(release, "1.1.1-test", "openedbot-preview_1.1.1-test_aarch64.app.tar.gz"), "");
      expect(path.basename(macArtifact(release, "1.1.1-test"))).toBe("openedbot-preview_1.1.1-test_aarch64.app.tar.gz");
      writeFileSync(path.join(release, "1.1.1-test", "openedbot_1.1.1-test_aarch64.app.tar.gz"), "");
      expect(path.basename(macArtifact(release, "1.1.1-test"))).toBe("openedbot_1.1.1-test_aarch64.app.tar.gz");
    } finally {
      rmSync(release, { recursive: true, force: true });
    }
  });
});
