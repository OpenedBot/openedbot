#!/usr/bin/env bun
/**
 * The local update feed of the prototype (ADR 0001, D2a): a Bun static server
 * on loopback and the command that "publishes" a built version into it. It
 * stands in for the future hosted feed (Q2: R2 behind a stable URL): nothing
 * here leaves this Mac.
 *
 *   bun apps/desktop-tauri/scripts/update-feed.ts serve [--port 8799] [--slow-kbps 300]
 *   bun apps/desktop-tauri/scripts/update-feed.ts publish --version 0.0.2
 *   bun apps/desktop-tauri/scripts/update-feed.ts publish --version 0.0.2 --announce 0.0.3 --forged-signature
 *   bun apps/desktop-tauri/scripts/update-feed.ts publish --version 1.1.1-test --platform linux-x86_64
 *   bun apps/desktop-tauri/scripts/update-feed.ts publish --version 0.0.18 --min-version 0.0.17 --max-age-days 30
 *
 * `publish` copies the signed update artifact into `release/feed/<version>/`
 * and writes `release/feed/latest.json`: `release/<version>/*.app.tar.gz{,.sig}`
 * for macOS, `dist-linux/<version>/<arch>/*.AppImage{,.sig}` for Linux (D5;
 * only the AppImage updates itself, a deb is left to the package manager).
 * `--forged-signature` signs the artifact with a throwaway key instead of the
 * update key: the installed app must refuse it and keep its version.
 * `--min-version` and `--max-age-days` write the manifest's floor (ADR 0001,
 * 4.3.3): an app under it shows « Mise à jour requise ». Announcing a version
 * older than the installed one (`--announce 0.0.1`) stands for a withdrawn
 * release: the app finds nothing newer.
 */
import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { artifactNames, IDENTITIES, linuxArtifactNames, type LinuxArch } from "./mac-identity";

const APP_DIR = path.resolve(import.meta.dir, "..");
const RELEASE = process.env.OPENEDBOT_RELEASE_DIR ?? path.join(APP_DIR, "release");
/** `release/<name>/`: `feed` for macOS, `feed-linux` for the Linux update test, so neither overwrites the other's manifest. */
let FEED = path.join(RELEASE, "feed");

/**
 * The macOS update artifact of a version: the production build's
 * (`openedbot_…`, D3) when there is one, the preview's otherwise. One version
 * is only ever built under one identity (numbers are never reused).
 */
export function macArtifact(release: string, version: string): string {
  const candidates = (["production", "preview"] as const).map((name) => path.join(release, version, artifactNames(IDENTITIES[name], version).tarball));
  return candidates.find((file) => existsSync(file)) ?? candidates[0]!;
}

/** The Linux update artifact of a version (an AppImage): the production build's first, as on macOS. */
export function linuxArtifact(distLinux: string, version: string, arch: LinuxArch): string {
  const candidates = (["production", "preview"] as const).map((name) => path.join(distLinux, version, arch, linuxArtifactNames(IDENTITIES[name], version, arch).appimage));
  return candidates.find((file) => existsSync(file)) ?? candidates[0]!;
}

/** Where a platform's signed artifact is, and the manifest key the updater looks up (`{os}-{arch}[-{installer}]`). */
export const PLATFORMS = {
  "darwin-aarch64": { key: "darwin-aarch64", artifact: (version: string) => macArtifact(RELEASE, version) },
  "linux-x86_64": { key: "linux-x86_64-appimage", artifact: (version: string) => linuxArtifact(path.join(APP_DIR, "dist-linux"), version, "x86_64") },
  "linux-aarch64": { key: "linux-aarch64-appimage", artifact: (version: string) => linuxArtifact(path.join(APP_DIR, "dist-linux"), version, "aarch64") },
} as const;
export type Platform = keyof typeof PLATFORMS;

export type UpdateManifest = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
  /** Under this version the app must update (`update_engine.rs`). */
  min_version?: string;
  /** A build older than this many days must update. */
  max_age_days?: number;
};

// X.Y.Z, or X.Y.Z-tag for a test build (semver: 1.1.1-test sorts after 1.1.0).
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

/** The manifest `tauri-plugin-updater` reads (static JSON format), plus the floor the shell reads: one platform. */
export function buildManifest(input: { version: string; url: string; signature: string; notes: string; pubDate: Date; platform?: Platform; minVersion?: string; maxAgeDays?: number }): UpdateManifest {
  const { url, signature, platform, ...rest } = input;
  return buildPlatformsManifest({ ...rest, platforms: { [platform ?? "darwin-aarch64"]: { url, signature } } });
}

/** The same manifest for several platforms (a release names all of them, `release.ts`). */
export function buildPlatformsManifest(input: { version: string; notes: string; pubDate: Date; platforms: Partial<Record<Platform, { url: string; signature: string }>>; minVersion?: string; maxAgeDays?: number }): UpdateManifest {
  if (!VERSION.test(input.version)) throw new Error(`invalid version ${input.version}`);
  const entries = Object.entries(input.platforms) as Array<[Platform, { url: string; signature: string }]>;
  if (entries.length === 0) throw new Error("a manifest names at least one platform");
  const platforms: UpdateManifest["platforms"] = {};
  for (const [platform, { url, signature }] of entries) {
    if (!(platform in PLATFORMS)) throw new Error(`unknown platform ${platform}`);
    const trimmed = signature.trim();
    if (!trimmed) throw new Error(`empty signature for ${platform}`);
    platforms[PLATFORMS[platform].key] = { signature: trimmed, url };
  }
  if (input.minVersion !== undefined && !VERSION.test(input.minVersion)) throw new Error(`invalid min version ${input.minVersion}`);
  if (input.maxAgeDays !== undefined && !(Number.isFinite(input.maxAgeDays) && input.maxAgeDays > 0)) throw new Error(`invalid max age ${input.maxAgeDays}`);
  return {
    version: input.version,
    notes: input.notes,
    pub_date: input.pubDate.toISOString(),
    platforms,
    ...(input.minVersion === undefined ? {} : { min_version: input.minVersion }),
    ...(input.maxAgeDays === undefined ? {} : { max_age_days: input.maxAgeDays }),
  };
}

/** A request path inside the feed directory, or null (traversal, odd characters). */
export function feedFile(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!/^\/[A-Za-z0-9._\/-]*$/.test(decoded) || decoded.split("/").some((segment) => segment === "..")) return null;
  const resolved = path.resolve(root, `.${decoded}`);
  return resolved.startsWith(`${path.resolve(root)}${path.sep}`) ? resolved : null;
}

/** An artifact sent at `kbps` kilobytes per second: the download stays visible long enough to watch. */
/**
 * Artifacts at `kbps` KB/s, with their Content-Length: `node:http` keeps a
 * declared length on a streamed body where `Bun.serve` turns it into chunked
 * encoding, and without a length the app cannot show a percentage.
 */
async function sendSlowly(response: ServerResponse, bytes: Uint8Array, kbps: number): Promise<void> {
  const chunk = 64 * 1024;
  for (let offset = 0; offset < bytes.length && !response.destroyed; offset += chunk) {
    await Bun.sleep((chunk / 1024 / kbps) * 1000);
    response.write(bytes.subarray(offset, offset + chunk));
  }
  response.end();
}

function serve(port: number, slowKbps: number | null): void {
  mkdirSync(FEED, { recursive: true });
  createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const file = feedFile(FEED, url.pathname);
    const found = file !== null && existsSync(file) && statSync(file).size > 0;
    console.log(JSON.stringify({ at: new Date().toISOString(), method: request.method, path: url.pathname, status: found ? 200 : 404, agent: request.headers["user-agent"] ?? null }));
    if (!found || request.method !== "GET") {
      response.writeHead(404).end("not found");
      return;
    }
    const bytes = readFileSync(file);
    // The manifest must never be cached: a stale one would hide a release.
    if (file.endsWith(".json")) {
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json", "Content-Length": bytes.length }).end(bytes);
      return;
    }
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
    if (slowKbps) void sendSlowly(response, bytes, slowKbps);
    else response.end(bytes);
  }).listen(port, "127.0.0.1");
  console.log(`update feed on http://127.0.0.1:${port}/latest.json (${FEED})${slowKbps ? `, artifacts at ${slowKbps} KB/s` : ""}`);
}

async function publish(options: { version: string; announce: string; forged: boolean; port: number; platform: Platform; manifest: string; minVersion?: string; maxAgeDays?: number }): Promise<void> {
  const source = PLATFORMS[options.platform].artifact(options.version);
  const artifact = path.basename(source);
  if (!existsSync(source) || !existsSync(`${source}.sig`)) throw new Error(`build ${options.version} first: ${source}{,.sig} missing`);
  const dir = path.join(FEED, options.version);
  mkdirSync(dir, { recursive: true });
  copyFileSync(source, path.join(dir, artifact));
  let signature = readFileSync(`${source}.sig`, "utf8");
  if (options.forged) {
    // A well-formed minisign signature, from a key the app does not trust.
    const scratch = mkdtempSync(path.join(tmpdir(), "openedbot-forged-"));
    try {
      const copy = path.join(scratch, artifact);
      copyFileSync(source, copy);
      await $`./node_modules/.bin/tauri signer generate --ci -p forged -w ${path.join(scratch, "forged.key")}`.cwd(APP_DIR).quiet();
      await $`./node_modules/.bin/tauri signer sign -f ${path.join(scratch, "forged.key")} -p forged ${copy}`.cwd(APP_DIR).quiet();
      signature = readFileSync(`${copy}.sig`, "utf8");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const manifest = buildManifest({
    version: options.announce,
    url: `http://127.0.0.1:${options.port}/${options.version}/${artifact}`,
    signature,
    notes: options.forged ? "forged signature, must be refused" : `prototype ${options.announce}`,
    pubDate: new Date(),
    platform: options.platform,
    minVersion: options.minVersion,
    maxAgeDays: options.maxAgeDays,
  });
  writeFileSync(path.join(FEED, options.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
  const floor = [options.minVersion && `min ${options.minVersion}`, options.maxAgeDays && `max age ${options.maxAgeDays} d`].filter(Boolean).join(", ");
  console.log(`published ${options.announce}${options.forged ? " (forged signature)" : ""}${floor ? ` (${floor})` : ""} -> ${path.join(FEED, options.manifest)}`);
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", default: "8799" },
      version: { type: "string" },
      announce: { type: "string" },
      "forged-signature": { type: "boolean", default: false },
      platform: { type: "string", default: "darwin-aarch64" },
      // Another manifest next to latest.json (forged.json): a test points one app at each.
      manifest: { type: "string", default: "latest.json" },
      feed: { type: "string", default: "feed" },
      "min-version": { type: "string" },
      "max-age-days": { type: "string" },
      "slow-kbps": { type: "string" },
    },
  });
  const port = Number(values.port);
  const platform = values.platform as Platform;
  if (!/^feed(?:-[a-z0-9]+)?$/.test(values.feed ?? "")) {
    console.error("--feed must be feed or feed-<name>");
    process.exit(1);
  }
  FEED = path.join(RELEASE, values.feed!);
  if (!/^[a-z0-9-]+\.json$/.test(values.manifest ?? "")) {
    console.error("--manifest must be a file name like latest.json");
    process.exit(1);
  }
  if (!(platform in PLATFORMS)) {
    console.error(`--platform must be one of ${Object.keys(PLATFORMS).join(", ")}`);
    process.exit(1);
  }
  if (positionals[0] === "serve") serve(port, values["slow-kbps"] ? Number(values["slow-kbps"]) : null);
  else if (positionals[0] === "publish" && values.version) {
    const maxAgeDays = values["max-age-days"] === undefined ? undefined : Number(values["max-age-days"]);
    await publish({ version: values.version, announce: values.announce ?? values.version, forged: values["forged-signature"] ?? false, port, platform, manifest: values.manifest!, minVersion: values["min-version"], maxAgeDays });
  } else {
    console.error("usage: update-feed.ts serve [--port N] [--feed feed-<name>] [--slow-kbps N] | publish --version X.Y.Z [--announce X.Y.Z] [--forged-signature] [--platform darwin-aarch64|linux-x86_64|linux-aarch64] [--manifest name.json] [--feed feed-<name>] [--min-version X.Y.Z] [--max-age-days N]");
    process.exit(1);
  }
}
