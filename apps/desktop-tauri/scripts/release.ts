#!/usr/bin/env bun
/**
 * Assembles a desktop release (ADR 0001, D3, D6) from the production builds
 * of every platform, ready to publish and published by nothing here:
 *
 *   bun apps/desktop-tauri/scripts/release.ts --version 1.1.0 [--notes CHANGELOG-extract.md]
 *
 * Inputs, each built with `--identity production` and the update key whose
 * public half is `apps/desktop-tauri/updater.pub`:
 *
 *   release/<version>/              build-mac.ts (Developer ID, notarised): dmg, .app.tar.gz + .sig
 *   dist-linux/<version>/x86_64/    build-linux.ts: deb, AppImage + .sig
 *   dist-linux/<version>/aarch64/   build-linux.ts: deb, AppImage + .sig
 *
 * Output, `release/<version>/publish/` (rebuilt on every run), laid out as
 * the bucket's `desktop/` prefix (R2, served by releases.openedbot.app):
 *
 *   v<version>/                     the ten files and SHA256SUMS -> desktop/v<version>/
 *                                   (immutable, never overwritten; SHA256SUMS last)
 *   solo/<channel>/latest.json      one manifest per channel, every platform
 *                                   -> desktop/solo/<channel>/latest.json (after the files)
 *   records/                        the builds' records (not uploaded)
 *   RELEASE_NOTES.md                when --notes is given (not uploaded)
 *
 * The app reads `desktop/solo/<channel>/latest.json` (`config.rs`,
 * `PRODUCTION_UPDATE_BASE`); only an AppImage updates itself on Linux, a deb
 * is left to its package manager. The tag `desktop/v<version>` then mirrors
 * the installers into the GitHub release under the names of `GITHUB_ASSETS`
 * (`.github/workflows/desktop-release.yml`), after checking them with
 *
 *   bun apps/desktop-tauri/scripts/release.ts verify --version 1.1.0 --dir DIR
 *
 * which checks a downloaded `v<version>/` directory: SHA256SUMS lists exactly
 * the release's files, each present with its sum, and every update artifact
 * is signed by the update key for this version.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { artifactNames, IDENTITIES, linuxArtifactNames, RELEASE_VERSION, type LinuxArch } from "./mac-identity";
import { parsePublicKey, verifySignature, type UpdatePublicKey } from "./minisign";
import { buildPlatformsManifest, type Platform, type UpdateManifest } from "./update-feed";

export const RELEASES_BASE = "https://releases.openedbot.app";
export const CHANNELS = ["beta", "stable"] as const;
export type Channel = (typeof CHANNELS)[number];
/** The variant of the desktop app (Q8: solo only). */
export const VARIANT = "solo";
export const LINUX_ARCHES: readonly LinuxArch[] = ["x86_64", "aarch64"];
const APP_DIR = path.resolve(import.meta.dir, "..");
/** The update key's public half, the trust anchor of every check here and in the tag workflow. */
export const UPDATE_PUBLIC_KEY = path.join(APP_DIR, "updater.pub");

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

export type ReleaseFile = {
  /** The file's name on R2 (`desktop/v<version>/<name>`). */
  name: string;
  /** Its name on the GitHub release (the site links `releases/latest/download/<github>`), null when not mirrored. */
  github: string | null;
  /** The update platform it serves (the manifest key), null for an installer only. */
  updates: Platform | null;
  /** Signed by the update key (`<name>.sig` next to it). */
  signed: boolean;
};

/** Every file of a release, in upload order (SHA256SUMS goes after all of them). */
export function releaseFiles(version: string): ReleaseFile[] {
  const mac = artifactNames(IDENTITIES.production, version);
  const files: ReleaseFile[] = [
    { name: mac.dmg, github: "openedbot-mac-arm64.dmg", updates: null, signed: false },
    { name: mac.tarball, github: null, updates: "darwin-aarch64", signed: true },
  ];
  for (const arch of LINUX_ARCHES) {
    const linux = linuxArtifactNames(IDENTITIES.production, version, arch);
    files.push(
      { name: linux.deb, github: `openedbot-linux-${arch === "x86_64" ? "amd64" : "arm64"}.deb`, updates: null, signed: false },
      { name: linux.appimage, github: `openedbot-linux-${arch}.AppImage`, updates: `linux-${arch}`, signed: true },
    );
  }
  return files;
}

/** The names on the GitHub release, which the site links to: kept stable from one version to the next. */
export const GITHUB_ASSETS = releaseFiles("0.0.0").flatMap((file) => (file.github ? [file.github] : []));

/** Every name SHA256SUMS lists: the files and their signatures. */
export function checksummed(version: string): string[] {
  return releaseFiles(version).flatMap((file) => (file.signed ? [file.name, `${file.name}.sig`] : [file.name]));
}

/** One channel's manifest: every platform's hosted artifact and its signature, no floor. */
export function releaseManifest(version: string, signatures: Partial<Record<Platform, string>>, notes: string, pubDate: Date): UpdateManifest {
  const layout = hostedLayout(version);
  const platforms: Partial<Record<Platform, { url: string; signature: string }>> = {};
  for (const file of releaseFiles(version)) {
    if (!file.updates) continue;
    const signature = signatures[file.updates];
    if (!signature) throw new Error(`no signature for ${file.updates}`);
    platforms[file.updates] = { url: layout.url(file.name), signature };
  }
  return buildPlatformsManifest({ version, notes, pubDate, platforms });
}

export function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** SHA256SUMS as `sha256sum` writes it: `<hex>  <name>`. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error(`SHA256SUMS: unreadable line ${JSON.stringify(line)}`);
    if (sums.has(match[2]!)) throw new Error(`SHA256SUMS: ${match[2]} listed twice`);
    sums.set(match[2]!, match[1]!);
  }
  return sums;
}

/**
 * Throws unless `signature` signs `content` with the update key, for this
 * version when the signature says one (Tauri writes `version:X.Y.Z` in the
 * trusted comment): an artifact of another build never enters a release.
 */
export function checkUpdateSignature(name: string, content: Uint8Array, signature: string, key: UpdatePublicKey, version: string): void {
  let comment: string;
  try {
    comment = verifySignature(content, signature, key);
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const signed = /(?:^|\t)version:([^\t]+)/.exec(comment)?.[1];
  if (signed !== undefined && signed !== version) throw new Error(`${name}: signed as version ${signed}, not ${version}`);
}

/**
 * Checks a directory laid out as `desktop/v<version>/`: SHA256SUMS lists
 * exactly the release's files, each present with its sum, and each update
 * artifact is signed by the update key. Returns the problems, empty when
 * the release is whole.
 */
export function verifyReleaseDir(dir: string, version: string, key: UpdatePublicKey): string[] {
  const sumsFile = path.join(dir, "SHA256SUMS");
  if (!existsSync(sumsFile)) return [`SHA256SUMS missing in ${dir}`];
  let sums: Map<string, string>;
  try {
    sums = parseSums(readFileSync(sumsFile, "utf8"));
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const problems: string[] = [];
  const expected = checksummed(version);
  for (const name of expected) if (!sums.has(name)) problems.push(`${name}: not listed in SHA256SUMS`);
  for (const name of sums.keys()) if (!expected.includes(name)) problems.push(`${name}: listed in SHA256SUMS but not part of the release`);
  for (const name of expected) {
    const file = path.join(dir, name);
    if (!existsSync(file)) problems.push(`${name}: missing`);
    else if (sums.has(name) && sha256(file) !== sums.get(name)) problems.push(`${name}: sha256 differs from SHA256SUMS`);
  }
  for (const file of releaseFiles(version).filter((entry) => entry.signed)) {
    const artifact = path.join(dir, file.name);
    if (!existsSync(artifact) || !existsSync(`${artifact}.sig`)) continue;
    try {
      checkUpdateSignature(file.name, readFileSync(artifact), readFileSync(`${artifact}.sig`, "utf8"), key, version);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return problems;
}

type MacBuild = { identity?: string; bundleId?: string; notarized?: boolean; sign?: string };
type LinuxBuild = { identity?: string; package?: string; signed?: boolean; version?: string; arch?: string };

/** Where each release file comes from: the platform builds of this version. */
function sources(version: string): Map<string, string> {
  const map = new Map<string, string>();
  const mac = artifactNames(IDENTITIES.production, version);
  const macDir = path.join(APP_DIR, "release", version);
  for (const name of [mac.dmg, mac.tarball, `${mac.tarball}.sig`]) map.set(name, path.join(macDir, name));
  for (const arch of LINUX_ARCHES) {
    const linux = linuxArtifactNames(IDENTITIES.production, version, arch);
    const linuxDir = path.join(APP_DIR, "dist-linux", version, arch);
    for (const name of [linux.deb, linux.appimage, `${linux.appimage}.sig`]) map.set(name, path.join(linuxDir, name));
  }
  return map;
}

function fail(message: string): never {
  console.error(`[release] ${message}`);
  process.exit(1);
}

function assemble(version: string, notes: string | undefined): void {
  if (!RELEASE_VERSION.test(version)) fail("--version X.Y.Z is required (a test build is never released)");
  const key = parsePublicKey(readFileSync(UPDATE_PUBLIC_KEY, "utf8"));

  // The builds: production identity, signed, this version.
  const macDir = path.join(APP_DIR, "release", version);
  const macRecord = path.join(macDir, "build.json");
  if (!existsSync(macRecord)) fail(`no macOS build of ${version}: make desktop-tauri-mac TAURI_VERSION=${version} TAURI_IDENTITY=production`);
  const mac = JSON.parse(readFileSync(macRecord, "utf8")) as MacBuild;
  if (mac.identity !== "production" || mac.bundleId !== IDENTITIES.production.bundleId) fail(`macOS ${version} is not a production build (${mac.identity}, ${mac.bundleId})`);
  if (mac.sign !== "developer-id" || !mac.notarized) fail(`macOS ${version} is not signed with the Developer ID and notarised`);
  const linuxRecords = new Map<LinuxArch, string>();
  for (const arch of LINUX_ARCHES) {
    const record = path.join(APP_DIR, "dist-linux", version, arch, "build.json");
    if (!existsSync(record)) fail(`no Linux ${arch} build of ${version}: make desktop-tauri-linux TAURI_VERSION=${version} TAURI_LINUX_ARCH=${arch} TAURI_IDENTITY=production`);
    const linux = JSON.parse(readFileSync(record, "utf8")) as LinuxBuild;
    if (linux.identity !== "production" || linux.package !== IDENTITIES.production.stem) fail(`Linux ${arch} ${version} is not a production build (${linux.identity}, ${linux.package})`);
    if (!linux.signed) fail(`Linux ${arch} ${version} was built --unsigned: its AppImage cannot update`);
    if (linux.version !== version || linux.arch !== arch) fail(`dist-linux/${version}/${arch} holds ${linux.version} ${linux.arch}`);
    linuxRecords.set(arch, record);
  }
  const from = sources(version);
  for (const [name, file] of from) if (!existsSync(file)) fail(`missing ${name}: ${file}`);

  // Always this subdirectory of the macOS build: rebuilt from scratch, never a path from the command line.
  const out = path.join(macDir, "publish");
  rmSync(out, { recursive: true, force: true });
  const files = path.join(out, `v${version}`);
  mkdirSync(files, { recursive: true });
  for (const [name, file] of from) copyFileSync(file, path.join(files, name));
  const names = checksummed(version);
  writeFileSync(path.join(files, "SHA256SUMS"), names.map((name) => `${sha256(path.join(files, name))}  ${name}\n`).join(""));

  // Signed by the update key, for this version, before any manifest names them.
  const problems = verifyReleaseDir(files, version, key);
  if (problems.length) fail(`the release does not hold together:\n  ${problems.join("\n  ")}`);

  const signatures: Partial<Record<Platform, string>> = {};
  for (const file of releaseFiles(version)) if (file.updates) signatures[file.updates] = readFileSync(path.join(files, `${file.name}.sig`), "utf8");
  const pubDate = new Date();
  for (const channel of CHANNELS) {
    mkdirSync(path.join(out, VARIANT, channel), { recursive: true });
    const manifest = releaseManifest(version, signatures, `openedbot ${version}`, pubDate);
    writeFileSync(path.join(out, VARIANT, channel, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  mkdirSync(path.join(out, "records"), { recursive: true });
  copyFileSync(macRecord, path.join(out, "records", "macos.json"));
  for (const [arch, record] of linuxRecords) copyFileSync(record, path.join(out, "records", `linux-${arch}.json`));
  if (notes) copyFileSync(path.resolve(notes), path.join(out, "RELEASE_NOTES.md"));

  const layout = hostedLayout(version);
  console.log(`[release] ${out}`);
  console.log(`  R2 ${layout.dir}/ <- v${version}/: ${names.join(", ")}, then SHA256SUMS`);
  for (const channel of CHANNELS) console.log(`  R2 ${layout.manifest(channel)} <- ${VARIANT}/${channel}/latest.json`);
  console.log(`  GitHub desktop/v${version}: ${GITHUB_ASSETS.join(", ")} (copied from R2 by desktop-release.yml)`);
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { version: { type: "string" }, notes: { type: "string" }, dir: { type: "string" } },
  });
  const version = values.version ?? "";
  if (positionals[0] === "verify" && positionals.length === 1) {
    if (!RELEASE_VERSION.test(version) || !values.dir) {
      console.error("usage: release.ts verify --version X.Y.Z --dir DIR");
      process.exit(2);
    }
    const problems = verifyReleaseDir(path.resolve(values.dir), version, parsePublicKey(readFileSync(UPDATE_PUBLIC_KEY, "utf8")));
    for (const problem of problems) console.error(`[release] ${problem}`);
    if (problems.length) process.exit(1);
    console.log(`[release] ${values.dir}: the ${checksummed(version).length} files of ${version}, sums and update signatures verified`);
  } else if (positionals.length === 0) {
    assemble(version, values.notes);
  } else {
    console.error("usage: release.ts --version X.Y.Z [--notes FILE] | release.ts verify --version X.Y.Z --dir DIR");
    process.exit(2);
  }
}
