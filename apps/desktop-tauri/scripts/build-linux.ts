#!/usr/bin/env bun
/**
 * Builds the Linux shell: the solo console embedded, a deb
 * and an AppImage for one architecture, plus the AppImage's signed update
 * artifact (`.AppImage` + `.sig`, the update key of the macOS build). Nothing
 * is published: the output stays in `apps/desktop-tauri/dist-linux/<version>/<arch>/`
 * (`make desktop-tauri-linux`), where `release.ts` gathers it.
 *
 *   bun apps/desktop-tauri/scripts/build-linux.ts --version 1.1.0 [--arch x86_64|aarch64]
 *       [--identity preview|production] [--docker] [--unsigned] [--out DIR]
 *
 * `--identity production` (D6) builds the released app from the overlay
 * `src-tauri/tauri.production.conf.json`, as `build-mac.ts` does: package
 * `openedbot`, executable `/usr/bin/openedbot`, `openedbot://` in the
 * `.desktop` entry, artifacts `openedbot_<version>_<arch>.*`. Its deb
 * declares that it replaces the earlier `openedbot-desktop` package (1.0.x),
 * so installing it over one swaps the two instead of failing on the files
 * they share (`/usr/share/applications/openedbot.desktop`, the icons). The
 * default stays the preview (`openedbot-preview`, `openedbot-preview://`),
 * which the end-to-end runs (`linux-e2e.ts`) drive.
 *
 * `--docker` (the default off Linux) builds the image `linux/Dockerfile` for
 * the architecture (OrbStack or Docker Desktop emulate amd64 on an arm64 Mac),
 * streams the working tree into a throwaway container (tracked and untracked
 * files, never ignored ones: no node_modules, no target, no secret file of
 * the repo) and runs this script there. On a Linux host or in that container
 * it builds directly; the CI job does that with `--unsigned`.
 *
 * The update key is `~/.config/openedbot-tauri-updater/updater.key{,.pass,.pub}`
 * (`OPENEDBOT_UPDATER_KEY_DIR`). The container gets the directory read only;
 * the key never enters the image, a layer, a log or the output. `--unsigned`
 * builds without updater artifacts (CI has no secret).
 */
import { $ } from "bun";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { DOCKER_PLATFORM, runInContainer } from "./linux-docker";
import { IDENTITIES, identityOverlay, linuxArtifactNames, mergeConfig, type IdentityName, type LinuxArch } from "./mac-identity";

const ROOT = path.resolve(import.meta.dir, "../../..");
const APP_DIR = path.join(ROOT, "apps/desktop-tauri");
const PLACEHOLDER = "openedbot-console-placeholder";
const API_ORIGIN_PLACEHOLDER = "__OPENEDBOT_DESKTOP_API_ORIGIN__";

/** The architecture names the bundler puts in the deb's and the AppImage's file names (they differ on arm64). */
export const DEB_ARCH: Record<LinuxArch, string> = { x86_64: "amd64", aarch64: "arm64" };
const APPIMAGE_ARCH: Record<LinuxArch, string> = { x86_64: "amd64", aarch64: "aarch64" };
/** The deb of the 1.0.x app, which the production deb replaces (`tauri.production.conf.json`). */
export const REPLACED_PACKAGE = "openedbot-desktop";

/** What the bundler writes under `bundle/{deb,appimage}/`: named after the product, so a stale bundle of the other identity never matches. */
export function bundlerNames(identity: IdentityName, version: string, arch: LinuxArch): { deb: string; appimage: string } {
  const product = IDENTITIES[identity].product;
  return { deb: `${product}_${version}_${DEB_ARCH[arch]}.deb`, appimage: `${product}_${version}_${APPIMAGE_ARCH[arch]}.AppImage` };
}

/** What the built deb must say about itself, for its identity (checked after every build). */
export function expectedPackage(identity: IdentityName): { name: string; binary: string; scheme: string; replaces: string | null } {
  const bundle = IDENTITIES[identity];
  return identity === "production"
    ? { name: bundle.stem, binary: `/usr/bin/${bundle.executable}`, scheme: bundle.scheme!, replaces: REPLACED_PACKAGE }
    : { name: bundle.stem, binary: `/usr/bin/${bundle.executable}`, scheme: "openedbot-preview", replaces: null };
}

/** A version the bundles accept: X.Y.Z, or X.Y.Z-tag for a test build (1.1.1-test). */
export function isLinuxVersion(version: string): boolean {
  return /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(version);
}

export function hostArch(arch: string = process.arch): LinuxArch | null {
  return arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
}

function fail(message: string): never {
  console.error(`[build-linux] ${message}`);
  process.exit(1);
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const timings: Record<string, number> = {};
async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  console.log(`[build-linux] ${label}…`);
  try {
    return await work();
  } finally {
    timings[label] = Math.round((performance.now() - started) / 1000);
    console.log(`[build-linux] ${label}: ${timings[label]} s`);
  }
}

type BuildOptions = { version: string; arch: LinuxArch; identity: IdentityName; signed: boolean; keyDir: string; out: string };

/** Off Linux (or on request): the same build inside the image, the working tree streamed in. */
async function buildInDocker(options: BuildOptions): Promise<void> {
  const { version, arch, identity, signed, keyDir, out } = options;
  mkdirSync(out, { recursive: true });
  const code = await timed(`docker build of ${version} (${arch})`, () =>
    runInContainer({
      arch,
      purpose: "build",
      mounts: [`${out}:/out`, ...(signed ? [`${keyDir}:/keys:ro`] : [])],
      script: [
        `bun apps/desktop-tauri/scripts/build-linux.ts --version ${version} --arch ${arch} --identity ${identity} --out /out ${signed ? "--key-dir /keys" : "--unsigned"}`,
        // The files belong to the host user, not to the container's root.
        'chown -R "$(stat -c %u:%g /out)" /out',
      ].join("\n"),
    }),
  );
  if (code !== 0) fail(`the container build failed (${code})`);
}

/** On Linux: console, Tauri bundles, collected artifacts. */
async function buildHere(options: BuildOptions): Promise<void> {
  const { version, arch, identity, signed, keyDir, out } = options;
  if (hostArch() !== arch) fail(`this host builds ${hostArch() ?? process.arch}, not ${arch}: use --docker`);
  if (signed) {
    for (const file of ["updater.key", "updater.key.pass", "updater.key.pub"]) {
      if (!existsSync(path.join(keyDir, file))) fail(`update key missing: ${path.join(keyDir, file)} (or --unsigned)`);
    }
  }

  // 1. The console, solo, desktop mode (same build as the macOS shell).
  await timed("console build", async () => {
    await $`./node_modules/.bin/vite build --logLevel warn --outDir ${path.join(APP_DIR, "console-dist")} --emptyOutDir`
      .cwd(path.join(ROOT, "apps/console"))
      .env({ ...process.env, OPENEDBOT_CONSOLE_PLUGINS: "", VITE_OPENEDBOT_SHELL: "tauri", VITE_API_ORIGIN: "" });
  });
  const html = readFileSync(path.join(APP_DIR, "console-dist/index.html"), "utf8");
  if (html.includes(PLACEHOLDER) || !html.includes(API_ORIGIN_PLACEHOLDER)) fail("console-dist is not a desktop console build");
  if (html.includes("umami")) fail("console-dist still loads the analytics script");

  // 2. Tauri: deb + AppImage (`tauri.linux.conf.json`, then the identity's
  // overlay), version and update key from here. The local feed is plain http
  // on loopback (`config.rs` refuses http anywhere else), hence the transport
  // flag, as on macOS.
  const staging = path.join(tmpdir(), `openedbot-linux-${process.pid}`);
  mkdirSync(staging, { recursive: true });
  const overlay = mergeConfig(identityOverlay(APP_DIR, IDENTITIES[identity]), {
    version,
    bundle: { createUpdaterArtifacts: signed },
    plugins: {
      updater: {
        pubkey: signed ? readFileSync(path.join(keyDir, "updater.key.pub"), "utf8").trim() : "",
        dangerousInsecureTransportProtocol: true,
      },
    },
  });
  const overlayFile = path.join(staging, "tauri.overlay.json");
  writeFileSync(overlayFile, JSON.stringify(overlay, null, 2));
  const buildEnv: Record<string, string | undefined> = {
    ...process.env,
    // The AppImage tools run without FUSE; linuxdeploy's old `strip` cannot
    // read the .relr.dyn sections of current toolchains.
    APPIMAGE_EXTRACT_AND_RUN: "1",
    NO_STRIP: "true",
    // Embedded by the shell (`option_env!`): the manifest's `max_age_days` measures the build's age from it.
    OPENEDBOT_BUILT_AT: String(Math.floor(Date.now() / 1000)),
  };
  if (signed) {
    buildEnv.TAURI_SIGNING_PRIVATE_KEY = path.join(keyDir, "updater.key");
    buildEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = readFileSync(path.join(keyDir, "updater.key.pass"), "utf8").trim();
  } else {
    delete buildEnv.TAURI_SIGNING_PRIVATE_KEY;
    delete buildEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  }
  try {
    await timed("tauri build", async () => {
      // Streamed as it goes; on failure, only the exit code (the output is already above).
      const { exitCode } = await $`./node_modules/.bin/tauri build --bundles deb,appimage --config ${overlayFile}`.cwd(APP_DIR).env(buildEnv).nothrow();
      if (exitCode !== 0) fail(`tauri build failed (${exitCode})`);
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  // 3. Collect under names without spaces.
  const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(APP_DIR, "src-tauri/target");
  const bundleDir = path.join(targetDir, "release/bundle");
  const bundled = bundlerNames(identity, version, arch);
  const deb = path.join(bundleDir, "deb", bundled.deb);
  const appimage = path.join(bundleDir, "appimage", bundled.appimage);
  for (const file of [deb, appimage]) if (!existsSync(file)) fail(`expected build output missing: ${file}`);
  const dest = path.join(out, version, arch);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const names = linuxArtifactNames(IDENTITIES[identity], version, arch);
  const artifacts: Record<string, string> = {
    deb: path.join(dest, names.deb),
    appimage: path.join(dest, names.appimage),
  };
  copyFileSync(deb, artifacts.deb!);
  copyFileSync(appimage, artifacts.appimage!);
  if (signed) {
    if (!existsSync(`${appimage}.sig`)) fail(`update signature missing: ${appimage}.sig`);
    artifacts.signature = `${artifacts.appimage}.sig`;
    copyFileSync(`${appimage}.sig`, artifacts.signature);
  }
  const sums = Object.values(artifacts).map((file) => `${sha256(file)}  ${path.basename(file)}`);
  writeFileSync(path.join(dest, "SHA256SUMS"), `${sums.join("\n")}\n`);

  // 4. The identity really built, then the record: package metadata, the
  // .desktop entry (deep link scheme), sizes and sums.
  console.log((await $`dpkg-deb --info ${artifacts.deb}`.quiet().text()).trim());
  const field = async (name: string) => (await $`dpkg-deb --field ${artifacts.deb} ${name}`.nothrow().quiet().text()).trim();
  // `dpkg-deb --contents` paths, with or without the leading `./`, as `/usr/bin/…`.
  const listing = (await $`dpkg-deb --contents ${artifacts.deb}`.quiet().text()).split("\n").map((line) => `/${line.split(/\s+/).slice(5).join(" ").replace(/^\.?\//, "")}`);
  const desktop = (await $`dpkg-deb --fsys-tarfile ${artifacts.deb} | tar -xOf - --wildcards '*.desktop'`.nothrow().quiet().text()).trim();
  console.log(`[build-linux] .desktop entry:\n${desktop}`);
  const built = { package: await field("Package"), version: await field("Version"), replaces: await field("Replaces"), conflicts: await field("Conflicts") };
  const expected = expectedPackage(identity);
  if (built.package !== expected.name || built.version !== version) fail(`the deb is ${built.package} ${built.version}, want ${expected.name} ${version}`);
  if (!listing.includes(expected.binary)) fail(`the deb does not install ${expected.binary}`);
  if (!desktop.split("\n").some((line) => line.startsWith("MimeType=") && line.split(/[=;]/).includes(`x-scheme-handler/${expected.scheme}`))) fail(`the .desktop entry does not declare ${expected.scheme}://`);
  if (expected.replaces && !(built.replaces.split(/,\s*/).includes(expected.replaces) && built.conflicts.split(/,\s*/).includes(expected.replaces))) fail(`the deb must replace and conflict with ${expected.replaces} (Replaces: ${built.replaces || "-"}, Conflicts: ${built.conflicts || "-"})`);
  const sizes = Object.fromEntries(Object.entries(artifacts).map(([kind, file]) => [kind, statSync(file).size]));
  writeFileSync(path.join(dest, "build.json"), `${JSON.stringify({ version, arch, identity, package: built.package, signed, timings, sizes, sha256: sums }, null, 2)}\n`);
  console.log(`[build-linux] done: ${dest}\n${sums.join("\n")}\n${JSON.stringify(timings)}`);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      arch: { type: "string" },
      docker: { type: "boolean", default: false },
      unsigned: { type: "boolean", default: false },
      identity: { type: "string", default: "preview" },
      out: { type: "string" },
      "key-dir": { type: "string" },
    },
  });
  const version = values.version ?? "";
  if (!isLinuxVersion(version)) fail("--version X.Y.Z (or X.Y.Z-tag) is required");
  const arch = (values.arch ?? hostArch() ?? "x86_64") as LinuxArch;
  if (!(arch in DOCKER_PLATFORM)) fail("--arch must be x86_64 or aarch64");
  if (!Object.hasOwn(IDENTITIES, values.identity ?? "")) fail("--identity must be preview or production");
  const options: BuildOptions = {
    version,
    arch,
    identity: values.identity as IdentityName,
    signed: !values.unsigned,
    keyDir: values["key-dir"] ?? process.env.OPENEDBOT_UPDATER_KEY_DIR ?? path.join(homedir(), ".config/openedbot-tauri-updater"),
    out: path.resolve(values.out ?? path.join(APP_DIR, "dist-linux")),
  };
  if (values.docker || process.platform !== "linux") await buildInDocker(options);
  else await buildHere(options);
}
