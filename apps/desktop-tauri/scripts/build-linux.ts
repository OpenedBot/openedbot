#!/usr/bin/env bun
/**
 * Builds the Linux shell (ADR 0001, D5): the solo console embedded, a deb
 * and an AppImage for one architecture, plus the AppImage's signed update
 * artifact (`.AppImage` + `.sig`, the update key of the macOS build). Nothing
 * is published: the output stays in `apps/desktop-tauri/dist-linux/<version>/<arch>/`
 * (`make desktop-tauri-linux`).
 *
 *   bun apps/desktop-tauri/scripts/build-linux.ts --version 1.1.0 [--arch x86_64|aarch64]
 *       [--docker] [--unsigned] [--out DIR]
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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { DOCKER_PLATFORM, runInContainer, type LinuxArch } from "./linux-docker";

const ROOT = path.resolve(import.meta.dir, "../../..");
const APP_DIR = path.join(ROOT, "apps/desktop-tauri");
const ARTIFACT_STEM = "openedbot-preview";
const PLACEHOLDER = "openedbot-console-placeholder";
const API_ORIGIN_PLACEHOLDER = "__OPENEDBOT_DESKTOP_API_ORIGIN__";

/** The architecture names the bundler puts in the deb's and the AppImage's file names (they differ on arm64). */
const DEB_ARCH: Record<LinuxArch, string> = { x86_64: "amd64", aarch64: "arm64" };
const APPIMAGE_ARCH: Record<LinuxArch, string> = { x86_64: "amd64", aarch64: "aarch64" };

/** A version the bundles accept: X.Y.Z, or X.Y.Z-tag for a test build (1.1.1-test). */
export function isLinuxVersion(version: string): boolean {
  return /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(version);
}

export function hostArch(arch: string = process.arch): LinuxArch | null {
  return arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
}

/** The single file of `dir` whose name ends with `suffix` (the bundler names them after the product). */
export function onlyFile(dir: string, suffix: string): string {
  const found = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(suffix)) : [];
  if (found.length !== 1) throw new Error(`expected one *${suffix} in ${dir}, found ${found.length ? found.join(", ") : "none"}`);
  return path.join(dir, found[0]!);
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

/** Off Linux (or on request): the same build inside the image, the working tree streamed in. */
async function buildInDocker(options: { version: string; arch: LinuxArch; signed: boolean; keyDir: string; out: string }): Promise<void> {
  const { version, arch, signed, keyDir, out } = options;
  mkdirSync(out, { recursive: true });
  const code = await timed(`docker build of ${version} (${arch})`, () =>
    runInContainer({
      arch,
      purpose: "build",
      mounts: [`${out}:/out`, ...(signed ? [`${keyDir}:/keys:ro`] : [])],
      script: [
        `bun apps/desktop-tauri/scripts/build-linux.ts --version ${version} --arch ${arch} --out /out ${signed ? "--key-dir /keys" : "--unsigned"}`,
        // The files belong to the host user, not to the container's root.
        'chown -R "$(stat -c %u:%g /out)" /out',
      ].join("\n"),
    }),
  );
  if (code !== 0) fail(`the container build failed (${code})`);
}

/** On Linux: console, Tauri bundles, collected artifacts. */
async function buildHere(options: { version: string; arch: LinuxArch; signed: boolean; keyDir: string; out: string }): Promise<void> {
  const { version, arch, signed, keyDir, out } = options;
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

  // 2. Tauri: deb + AppImage (`tauri.linux.conf.json`), version and update key
  // from here. The local feed is plain http on loopback (`config.rs` refuses
  // http anywhere else), hence the transport flag, as on macOS.
  const staging = path.join(tmpdir(), `openedbot-linux-${process.pid}`);
  mkdirSync(staging, { recursive: true });
  const overlay = {
    version,
    bundle: { createUpdaterArtifacts: signed },
    plugins: {
      updater: {
        pubkey: signed ? readFileSync(path.join(keyDir, "updater.key.pub"), "utf8").trim() : "",
        dangerousInsecureTransportProtocol: true,
      },
    },
  };
  const overlayFile = path.join(staging, "tauri.overlay.json");
  writeFileSync(overlayFile, JSON.stringify(overlay, null, 2));
  const buildEnv: Record<string, string | undefined> = {
    ...process.env,
    // The AppImage tools run without FUSE; linuxdeploy's old `strip` cannot
    // read the .relr.dyn sections of current toolchains.
    APPIMAGE_EXTRACT_AND_RUN: "1",
    NO_STRIP: "true",
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
  const deb = onlyFile(path.join(bundleDir, "deb"), `_${version}_${DEB_ARCH[arch]}.deb`);
  const appimage = onlyFile(path.join(bundleDir, "appimage"), `_${version}_${APPIMAGE_ARCH[arch]}.AppImage`);
  const dest = path.join(out, version, arch);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const artifacts: Record<string, string> = {
    deb: path.join(dest, `${ARTIFACT_STEM}_${version}_${arch}.deb`),
    appimage: path.join(dest, `${ARTIFACT_STEM}_${version}_${arch}.AppImage`),
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
  const sizes = Object.fromEntries(Object.entries(artifacts).map(([kind, file]) => [kind, statSync(file).size]));
  writeFileSync(path.join(dest, "build.json"), `${JSON.stringify({ version, arch, signed, timings, sizes, sha256: sums }, null, 2)}\n`);

  // 4. The record: package metadata, the .desktop entry (deep link scheme), libraries.
  console.log((await $`dpkg-deb --info ${artifacts.deb}`.quiet().text()).trim());
  const desktop = (await $`dpkg-deb --fsys-tarfile ${artifacts.deb} | tar -xOf - --wildcards '*.desktop'`.nothrow().quiet().text()).trim();
  console.log(`[build-linux] .desktop entry:\n${desktop}`);
  console.log(`[build-linux] done: ${dest}\n${sums.join("\n")}\n${JSON.stringify(timings)}`);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      arch: { type: "string" },
      docker: { type: "boolean", default: false },
      unsigned: { type: "boolean", default: false },
      out: { type: "string" },
      "key-dir": { type: "string" },
    },
  });
  const version = values.version ?? "";
  if (!isLinuxVersion(version)) fail("--version X.Y.Z (or X.Y.Z-tag) is required");
  const arch = (values.arch ?? hostArch() ?? "x86_64") as LinuxArch;
  if (!(arch in DOCKER_PLATFORM)) fail("--arch must be x86_64 or aarch64");
  const options = {
    version,
    arch,
    signed: !values.unsigned,
    keyDir: values["key-dir"] ?? process.env.OPENEDBOT_UPDATER_KEY_DIR ?? path.join(homedir(), ".config/openedbot-tauri-updater"),
    out: path.resolve(values.out ?? path.join(APP_DIR, "dist-linux")),
  };
  if (values.docker || process.platform !== "linux") await buildInDocker(options);
  else await buildHere(options);
}
