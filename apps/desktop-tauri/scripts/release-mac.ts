#!/usr/bin/env bun
/**
 * Assembles a macOS release of the production app (ADR 0001, D3) from a
 * notarised build (`build-mac.ts --identity production`), ready to publish
 * and published by nothing here:
 *
 *   bun apps/desktop-tauri/scripts/release-mac.ts --version 1.1.0 [--notes CHANGELOG-extract.md]
 *
 * Output, `release/<version>/publish/` (rebuilt on every run):
 *
 *   openedbot_<version>_aarch64.dmg            the installer (R2; the GitHub release mirrors it
 *                                              as openedbot-mac-arm64.dmg, desktop-release.yml)
 *   openedbot_<version>_aarch64.app.tar.gz     the update artifact, and its minisign .sig
 *   SHA256SUMS                                 the three files above
 *   manifests/beta/latest.json                 the beta channel's manifest
 *   manifests/stable/latest.json               the stable channel's, uploaded at promotion only
 *   build.json                                 the build's record (identity, notch commit, timings)
 *   RELEASE_NOTES.md                           when --notes is given
 *
 * The hosted layout (Q2), on the R2 bucket served by releases.openedbot.app:
 * the files under `desktop/v<version>/` (immutable, never overwritten), then
 * a channel's manifest at `desktop/solo/<channel>/latest.json`, the URL the
 * app reads (`config.rs`, `PRODUCTION_UPDATE_BASE`). The manifest goes last:
 * it never names a file not yet served.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { artifactNames, IDENTITIES, RELEASE_VERSION } from "./mac-identity";
import { buildManifest, type UpdateManifest } from "./update-feed";

export const RELEASES_BASE = "https://releases.openedbot.app";
export const CHANNELS = ["beta", "stable"] as const;
export type Channel = (typeof CHANNELS)[number];
/** The variant of the desktop app (Q8: solo only). */
export const VARIANT = "solo";
/** The dmg's name on the GitHub release, which the site links to (`desktop-release.yml` copies it there). */
export const GITHUB_DMG = "openedbot-mac-arm64.dmg";

/** Where a version's files and a channel's manifest live on the bucket. */
export function hostedLayout(version: string): { dir: string; manifest: (channel: Channel) => string; url: (file: string) => string } {
  if (!RELEASE_VERSION.test(version)) throw new Error(`a release is X.Y.Z, got ${version}`);
  const dir = `desktop/v${version}`;
  return {
    dir,
    manifest: (channel) => `desktop/${VARIANT}/${channel}/latest.json`,
    url: (file) => `${RELEASES_BASE}/${dir}/${file}`,
  };
}

/** One channel's manifest: the hosted artifact, its signature, no floor. */
export function releaseManifest(version: string, signature: string, notes: string, pubDate: Date): UpdateManifest {
  const tarball = artifactNames(IDENTITIES.production, version).tarball;
  return buildManifest({ version, url: hostedLayout(version).url(tarball), signature, notes, pubDate });
}

export function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { version: { type: "string" }, notes: { type: "string" } } });
  const version = values.version ?? "";
  const fail = (message: string): never => {
    console.error(`[release-mac] ${message}`);
    process.exit(1);
  };
  if (!RELEASE_VERSION.test(version)) fail("--version X.Y.Z is required (a test build is never released)");
  const appDir = path.resolve(import.meta.dir, "..");
  const built = path.join(appDir, "release", version);
  const build = JSON.parse(readFileSync(path.join(built, "build.json"), "utf8")) as { identity?: string; bundleId?: string; notarized?: boolean; sign?: string };
  if (build.identity !== "production" || build.bundleId !== IDENTITIES.production.bundleId) fail(`${version} is not a production build (${build.identity}, ${build.bundleId})`);
  if (build.sign !== "developer-id" || !build.notarized) fail(`${version} is not signed with the Developer ID and notarised`);
  const names = artifactNames(IDENTITIES.production, version);
  for (const file of [names.dmg, names.tarball, `${names.tarball}.sig`]) if (!existsSync(path.join(built, file))) fail(`missing ${file} in ${built}`);

  // Always this subdirectory of the build: rebuilt from scratch, never a path from the command line.
  const out = path.join(built, "publish");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, "manifests"), { recursive: true });
  copyFileSync(path.join(built, names.dmg), path.join(out, names.dmg));
  copyFileSync(path.join(built, "build.json"), path.join(out, "build.json"));
  copyFileSync(path.join(built, names.tarball), path.join(out, names.tarball));
  copyFileSync(path.join(built, `${names.tarball}.sig`), path.join(out, `${names.tarball}.sig`));
  const signature = readFileSync(path.join(built, `${names.tarball}.sig`), "utf8");
  const pubDate = new Date();
  for (const channel of CHANNELS) {
    mkdirSync(path.join(out, "manifests", channel), { recursive: true });
    const manifest = releaseManifest(version, signature, `openedbot ${version}`, pubDate);
    writeFileSync(path.join(out, "manifests", channel, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const files = [names.dmg, names.tarball, `${names.tarball}.sig`];
  writeFileSync(path.join(out, "SHA256SUMS"), files.map((file) => `${sha256(path.join(out, file))}  ${file}\n`).join(""));
  if (values.notes) copyFileSync(path.resolve(values.notes), path.join(out, "RELEASE_NOTES.md"));
  const layout = hostedLayout(version);
  console.log(`[release-mac] ${out}`);
  console.log(`  R2 ${layout.dir}/: ${[names.dmg, names.tarball, `${names.tarball}.sig`, "SHA256SUMS"].join(", ")}`);
  for (const channel of CHANNELS) console.log(`  R2 ${layout.manifest(channel)} <- manifests/${channel}/latest.json`);
  console.log(`  GitHub desktop/v${version}: ${GITHUB_DMG} (copied from R2 by desktop-release.yml)`);
}
