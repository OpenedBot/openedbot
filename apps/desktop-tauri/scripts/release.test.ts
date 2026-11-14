import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactNames, BUILD_VERSION, IDENTITIES, identityOverlay, mergeConfig, RELEASE_VERSION } from "./mac-identity";
import { parsePublicKey } from "./minisign";
import { checksummed, GITHUB_ASSETS, hostedLayout, releaseFiles, releaseManifest, sha256, verifyReleaseDir } from "./release";
import { testKey, type TestKey } from "./test-signing";
import { linuxArtifact, macArtifact } from "./update-feed";

const APP_DIR = path.resolve(import.meta.dir, "..");
const REPO = path.resolve(APP_DIR, "../..");

describe("production identity (D3, D6)", () => {
  test("the production overlay is the identity the scripts expect", () => {
    const overlay = identityOverlay(APP_DIR, IDENTITIES.production);
    expect(overlay).toMatchObject({ identifier: "app.openedbot.desktop", productName: "openedbot", mainBinaryName: "openedbot" });
    expect((overlay.plugins as { "deep-link": { desktop: { schemes: string[] } } })["deep-link"].desktop.schemes).toEqual(["openedbot"]);
    // The deb replaces the 1.0.x package (`openedbot-desktop`) instead of failing on the files they share.
    expect(overlay.bundle).toMatchObject({ linux: { deb: { conflicts: ["openedbot-desktop"], replaces: ["openedbot-desktop"] } } });
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
});

describe("release layout (D6)", () => {
  test("one immutable version directory for macOS and Linux, a manifest per variant and channel", () => {
    const layout = hostedLayout("1.1.0");
    expect(layout.dir).toBe("desktop/v1.1.0");
    expect(layout.manifest("beta")).toBe("desktop/solo/beta/latest.json");
    expect(layout.manifest("stable")).toBe("desktop/solo/stable/latest.json");
    expect(checksummed("1.1.0")).toEqual([
      "openedbot_1.1.0_aarch64.dmg",
      "openedbot_1.1.0_aarch64.app.tar.gz",
      "openedbot_1.1.0_aarch64.app.tar.gz.sig",
      "openedbot_1.1.0_x86_64.deb",
      "openedbot_1.1.0_x86_64.AppImage",
      "openedbot_1.1.0_x86_64.AppImage.sig",
      "openedbot_1.1.0_aarch64.deb",
      "openedbot_1.1.0_aarch64.AppImage",
      "openedbot_1.1.0_aarch64.AppImage.sig",
    ]);
  });

  test("the GitHub names stay those the site links to, plus the arm64 Linux ones", () => {
    expect(GITHUB_ASSETS).toEqual([
      "openedbot-mac-arm64.dmg",
      "openedbot-linux-amd64.deb",
      "openedbot-linux-x86_64.AppImage",
      "openedbot-linux-arm64.deb",
      "openedbot-linux-aarch64.AppImage",
    ]);
  });

  test("a channel's manifest names every platform, Linux by its AppImage only", () => {
    const manifest = releaseManifest("1.1.0", { "darwin-aarch64": "bWFj\n", "linux-x86_64": "eDY0\n", "linux-aarch64": "YXJt\n" }, "openedbot 1.1.0", new Date("2026-11-06T12:00:00Z"));
    const base = "https://releases.openedbot.app/desktop/v1.1.0";
    expect(manifest.platforms).toEqual({
      "darwin-aarch64": { signature: "bWFj", url: `${base}/openedbot_1.1.0_aarch64.app.tar.gz` },
      "linux-x86_64-appimage": { signature: "eDY0", url: `${base}/openedbot_1.1.0_x86_64.AppImage` },
      "linux-aarch64-appimage": { signature: "YXJt", url: `${base}/openedbot_1.1.0_aarch64.AppImage` },
    });
    expect(manifest.version).toBe("1.1.0");
    expect("min_version" in manifest).toBe(false);
    expect(() => releaseManifest("1.1.0", { "darwin-aarch64": "bWFj" }, "", new Date())).toThrow(/no signature for linux-x86_64/);
  });

  test("the tag workflow mirrors every GitHub file and checks the release with release.ts verify", () => {
    const workflow = readFileSync(path.join(REPO, ".github/workflows/desktop-release.yml"), "utf8");
    for (const name of GITHUB_ASSETS) expect(workflow).toContain(name);
    expect(workflow).toContain("apps/desktop-tauri/scripts/release.ts verify");
    expect(workflow).not.toMatch(/\bwin(dows)?\b|\.exe\b|nsis/i);
  });
});

/** A downloaded `desktop/v<version>/` directory, signed with `key`, and its SHA256SUMS lines. */
function releaseDir(version: string, key: TestKey): { dir: string; sums: Map<string, string> } {
  const dir = mkdtempSync(path.join(tmpdir(), "openedbot-release-"));
  for (const file of releaseFiles(version)) {
    writeFileSync(path.join(dir, file.name), `content of ${file.name}`);
    if (file.signed) writeFileSync(path.join(dir, `${file.name}.sig`), key.sign(readFileSync(path.join(dir, file.name)), { version }));
  }
  const sums = new Map(checksummed(version).map((name) => [name, sha256(path.join(dir, name))]));
  writeSums(dir, sums);
  return { dir, sums };
}

function writeSums(dir: string, sums: Map<string, string>): void {
  writeFileSync(path.join(dir, "SHA256SUMS"), [...sums].map(([name, sum]) => `${sum}  ${name}\n`).join(""));
}

describe("release.ts verify (what the tag workflow runs on the files from R2)", () => {
  test("a whole release passes", () => {
    const key = testKey();
    const { dir } = releaseDir("1.1.0", key);
    try {
      expect(verifyReleaseDir(dir, "1.1.0", parsePublicKey(key.publicKeyFile))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a changed file, a missing one, an unlisted one, another key or another version is named", () => {
    const key = testKey();
    const { dir, sums } = releaseDir("1.1.0", key);
    try {
      // A file changed after its sum was taken.
      writeFileSync(path.join(dir, "openedbot_1.1.0_x86_64.deb"), "tampered");
      // A file gone, and gone from the list.
      rmSync(path.join(dir, "openedbot_1.1.0_aarch64.deb"));
      sums.delete("openedbot_1.1.0_aarch64.deb");
      // A file that is not part of the release.
      sums.set("extra.bin", "0".repeat(64));
      // Signed by another key, sum kept in step: only the signature is wrong.
      const appimage = "openedbot_1.1.0_x86_64.AppImage";
      writeFileSync(path.join(dir, `${appimage}.sig`), testKey().sign(readFileSync(path.join(dir, appimage)), { version: "1.1.0" }));
      sums.set(`${appimage}.sig`, sha256(path.join(dir, `${appimage}.sig`)));
      // Signed by the right key for another version.
      const tarball = artifactNames(IDENTITIES.production, "1.1.0").tarball;
      writeFileSync(path.join(dir, `${tarball}.sig`), key.sign(readFileSync(path.join(dir, tarball)), { version: "1.0.9" }));
      sums.set(`${tarball}.sig`, sha256(path.join(dir, `${tarball}.sig`)));
      writeSums(dir, sums);

      const problems = verifyReleaseDir(dir, "1.1.0", parsePublicKey(key.publicKeyFile));
      expect(problems).toEqual(expect.arrayContaining([
        "openedbot_1.1.0_aarch64.deb: not listed in SHA256SUMS",
        "openedbot_1.1.0_aarch64.deb: missing",
        "extra.bin: listed in SHA256SUMS but not part of the release",
        "openedbot_1.1.0_x86_64.deb: sha256 differs from SHA256SUMS",
        expect.stringMatching(/^openedbot_1\.1\.0_x86_64\.AppImage: signed by key \S+, not by the update key/),
        "openedbot_1.1.0_aarch64.app.tar.gz: signed as version 1.0.9, not 1.1.0",
      ]));
      expect(problems).toHaveLength(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no SHA256SUMS: nothing is trusted", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openedbot-release-"));
    try {
      expect(verifyReleaseDir(dir, "1.1.0", parsePublicKey(testKey().publicKeyFile))).toEqual([`SHA256SUMS missing in ${dir}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("local feed", () => {
  test("finds a production build before a preview one, on macOS and on Linux", () => {
    const release = mkdtempSync(path.join(tmpdir(), "openedbot-release-"));
    try {
      mkdirSync(path.join(release, "1.1.1-test"));
      expect(macArtifact(release, "1.1.1-test")).toBe(path.join(release, "1.1.1-test", artifactNames(IDENTITIES.production, "1.1.1-test").tarball));
      writeFileSync(path.join(release, "1.1.1-test", "openedbot-preview_1.1.1-test_aarch64.app.tar.gz"), "");
      expect(path.basename(macArtifact(release, "1.1.1-test"))).toBe("openedbot-preview_1.1.1-test_aarch64.app.tar.gz");
      writeFileSync(path.join(release, "1.1.1-test", "openedbot_1.1.1-test_aarch64.app.tar.gz"), "");
      expect(path.basename(macArtifact(release, "1.1.1-test"))).toBe("openedbot_1.1.1-test_aarch64.app.tar.gz");

      const linux = path.join(release, "1.1.1-test", "x86_64");
      mkdirSync(linux);
      writeFileSync(path.join(linux, "openedbot-preview_1.1.1-test_x86_64.AppImage"), "");
      expect(path.basename(linuxArtifact(release, "1.1.1-test", "x86_64"))).toBe("openedbot-preview_1.1.1-test_x86_64.AppImage");
      writeFileSync(path.join(linux, "openedbot_1.1.1-test_x86_64.AppImage"), "");
      expect(path.basename(linuxArtifact(release, "1.1.1-test", "x86_64"))).toBe("openedbot_1.1.1-test_x86_64.AppImage");
    } finally {
      rmSync(release, { recursive: true, force: true });
    }
  });
});
