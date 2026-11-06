#!/usr/bin/env bun
/**
 * Builds the macOS prototype (ADR 0001, D2a): the solo console embedded, the
 * notch popup in `Contents/Helpers`, signed with the Developer ID (hardened
 * runtime, no App Sandbox, no entitlements), notarised and stapled, plus the
 * signed update artifact (`.app.tar.gz` + `.sig`, update key distinct from
 * the Developer ID). Nothing is published: the output stays in
 * `apps/desktop-tauri/release/<version>/` (`make desktop-tauri-mac`).
 *
 *   bun apps/desktop-tauri/scripts/build-mac.ts --version 0.0.2 [--sign developer-id|adhoc]
 *       [--popup /path/OpenedbotPopup.app] [--no-notarize]
 *
 * Secrets are read from files and handed to the tools through the
 * environment, never printed:
 *   - Developer ID: the login keychain (`MAC_SIGN_IDENTITY`, default below);
 *   - notarisation: `APPLE_API_KEY_PATH` (.p8), `APPLE_API_KEY` (key id),
 *     `APPLE_API_ISSUER`; defaults to `~/.config/openedbot-macsign/secrets`;
 *   - update key: `~/.config/openedbot-tauri-updater/updater.key{,.pass,.pub}`
 *     (`OPENEDBOT_UPDATER_KEY_DIR`).
 */
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const ROOT = path.resolve(import.meta.dir, "../../..");
const APP_DIR = path.join(ROOT, "apps/desktop-tauri");
const PRODUCT = "openedbot preview";
const ARTIFACT_STEM = "openedbot-preview";
const DEFAULT_IDENTITY = "Developer ID Application: kevin aubrée (QDC76LMF29)";
const PLACEHOLDER = "openedbot-console-placeholder";
const API_ORIGIN_PLACEHOLDER = "__OPENEDBOT_DESKTOP_API_ORIGIN__";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    sign: { type: "string", default: "developer-id" },
    popup: { type: "string" },
    "no-notarize": { type: "boolean", default: false },
  },
});

const version = values.version ?? "";
if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)) fail("--version X.Y.Z is required");
const sign = values.sign;
if (sign !== "developer-id" && sign !== "adhoc") fail("--sign must be developer-id or adhoc");
const notarize = sign === "developer-id" && !values["no-notarize"];

const secrets = path.join(homedir(), ".config/openedbot-macsign/secrets");
const apple = {
  keyPath: process.env.APPLE_API_KEY_PATH ?? path.join(secrets, "AuthKey.p8"),
  keyId: process.env.APPLE_API_KEY ?? "LQ4442L52B",
  issuer: process.env.APPLE_API_ISSUER ?? "24d42ba4-6612-4bd5-b89c-ccf2006c8696",
};
const identity = process.env.MAC_SIGN_IDENTITY ?? DEFAULT_IDENTITY;
const updaterDir = process.env.OPENEDBOT_UPDATER_KEY_DIR ?? path.join(homedir(), ".config/openedbot-tauri-updater");
const out = path.join(APP_DIR, "release", version);
const timings: Record<string, number> = {};

function fail(message: string): never {
  console.error(`[build-mac] ${message}`);
  process.exit(1);
}

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  console.log(`[build-mac] ${label}…`);
  try {
    return await work();
  } finally {
    timings[label] = Math.round((performance.now() - started) / 1000);
    console.log(`[build-mac] ${label}: ${timings[label]} s`);
  }
}

if (process.platform !== "darwin") fail("macOS only");
for (const file of ["updater.key", "updater.key.pass", "updater.key.pub"]) {
  if (!existsSync(path.join(updaterDir, file))) fail(`update key missing: ${path.join(updaterDir, file)} (tauri signer generate, see the ADR 4.3.1)`);
}
if (notarize && !existsSync(apple.keyPath)) fail(`notarisation key missing: ${apple.keyPath}`);
if (sign === "developer-id") {
  const identities = await $`security find-identity -v -p codesigning`.text();
  if (!identities.includes(`"${identity}"`)) fail(`signing identity not in the keychain: ${identity}`);
}

// 1. The console, solo, desktop mode (no analytics, CSP with the runtime API placeholder).
await timed("console build", async () => {
  await $`./node_modules/.bin/vite build --logLevel warn --outDir ${path.join(APP_DIR, "console-dist")} --emptyOutDir`
    .cwd(path.join(ROOT, "apps/console"))
    .env({ ...process.env, OPENEDBOT_CONSOLE_PLUGINS: "", VITE_OPENEDBOT_SHELL: "tauri", VITE_API_ORIGIN: "" });
});
const html = readFileSync(path.join(APP_DIR, "console-dist/index.html"), "utf8");
if (html.includes(PLACEHOLDER) || !html.includes(API_ORIGIN_PLACEHOLDER)) fail("console-dist is not a desktop console build");
if (html.includes("umami")) fail("console-dist still loads the analytics script");

// 2. The notch popup, re-signed with the same identity before the app is
// (inside out: notarisation refuses a nested binary without hardened runtime
// and secure timestamp).
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const staging = path.join(out, "staging");
mkdirSync(staging, { recursive: true });
const popupSource = values.popup ?? process.env.OPENEDBOT_POPUP_APP ?? path.join(ROOT, "../openedbot-notch/dist/OpenedbotPopup.app");
const popupExecutable = path.join(popupSource, "Contents/MacOS/OpenedbotPopup");
if (!existsSync(popupExecutable)) fail(`popup bundle missing: ${popupSource} (make -C openedbot-notch bundle)`);
const declared = (await $`/usr/libexec/PlistBuddy -c "Print :OpenedbotHostedProtocol" ${path.join(popupSource, "Contents/Info.plist")}`.nothrow().text()).trim();
if (declared !== "1") fail(`${popupSource} does not declare OpenedbotHostedProtocol 1`);
const popup = path.join(staging, "OpenedbotPopup.app");
await $`ditto ${popupSource} ${popup}`;
const popupIdentity = sign === "developer-id" ? identity : "-";
await $`codesign --force --options runtime --timestamp --sign ${popupIdentity} ${popup}`.quiet();

// 3. The Tauri build: version, popup and update public key come from here,
// never from the committed config. The local feed is plain http on loopback
// (`config.rs` refuses http anywhere else), hence the transport flag.
const overlay = {
  version,
  bundle: {
    createUpdaterArtifacts: true,
    macOS: {
      signingIdentity: sign === "developer-id" ? identity : "-",
      files: { "Helpers/OpenedbotPopup.app": popup },
    },
  },
  plugins: {
    updater: {
      pubkey: readFileSync(path.join(updaterDir, "updater.key.pub"), "utf8").trim(),
      dangerousInsecureTransportProtocol: true,
    },
  },
};
const overlayFile = path.join(staging, "tauri.overlay.json");
writeFileSync(overlayFile, JSON.stringify(overlay, null, 2));
const buildEnv: Record<string, string | undefined> = {
  ...process.env,
  TAURI_SIGNING_PRIVATE_KEY: path.join(updaterDir, "updater.key"),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: readFileSync(path.join(updaterDir, "updater.key.pass"), "utf8").trim(),
  APPLE_SIGNING_IDENTITY: sign === "developer-id" ? identity : "-",
  // Embedded by the shell (`option_env!`): the manifest's `max_age_days` measures the build's age from it.
  OPENEDBOT_BUILT_AT: String(Math.floor(Date.now() / 1000)),
};
if (notarize) Object.assign(buildEnv, { APPLE_API_KEY_PATH: apple.keyPath, APPLE_API_KEY: apple.keyId, APPLE_API_ISSUER: apple.issuer });
else for (const name of ["APPLE_API_KEY_PATH", "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_ID", "APPLE_PASSWORD"]) delete buildEnv[name];
await timed(notarize ? "tauri build + app notarisation" : "tauri build", async () => {
  await $`./node_modules/.bin/tauri build --bundles app,dmg --config ${overlayFile}`.cwd(APP_DIR).env(buildEnv);
});

const bundleDir = path.join(APP_DIR, "src-tauri/target/release/bundle");
const app = path.join(bundleDir, "macos", `${PRODUCT}.app`);
const tarball = path.join(bundleDir, "macos", `${PRODUCT}.app.tar.gz`);
const dmg = path.join(bundleDir, "dmg", `${PRODUCT}_${version}_aarch64.dmg`);
for (const file of [app, tarball, `${tarball}.sig`, dmg]) if (!existsSync(file)) fail(`expected build output missing: ${file}`);

// 4. The dmg itself: signed, notarised and stapled, so Gatekeeper checks it offline.
if (sign === "developer-id") await $`codesign --force --timestamp --sign ${identity} ${dmg}`.quiet();
if (notarize) {
  await timed("dmg notarisation", async () => {
    await $`xcrun notarytool submit ${dmg} --key ${apple.keyPath} --key-id ${apple.keyId} --issuer ${apple.issuer} --wait`;
  });
  await $`xcrun stapler staple ${dmg}`.quiet();
}

// 5. Collect the artifacts under names without spaces.
const artifacts = {
  dmg: path.join(out, `${ARTIFACT_STEM}_${version}_aarch64.dmg`),
  tarball: path.join(out, `${ARTIFACT_STEM}_${version}_aarch64.app.tar.gz`),
};
await $`cp ${dmg} ${artifacts.dmg}`;
await $`cp ${tarball} ${artifacts.tarball}`;
await $`cp ${tarball}.sig ${artifacts.tarball}.sig`;
rmSync(staging, { recursive: true, force: true });

// 6. Checks, printed for the record (ADR 4.3.1).
const checks = [
  $`codesign --verify --deep --strict --verbose=2 ${app}`,
  $`codesign -d --entitlements - ${app}`,
  $`codesign -dv --verbose=2 ${path.join(app, "Contents/Helpers/OpenedbotPopup.app")}`,
  $`spctl -a -vv ${app}`,
  $`spctl -a -t open --context context:primary-signature -vv ${artifacts.dmg}`,
  $`xcrun stapler validate ${app}`,
  $`xcrun stapler validate ${artifacts.dmg}`,
];
for (const check of checks) {
  const result = await check.nothrow().quiet();
  console.log(`[build-mac] check exit ${result.exitCode}\n${result.stdout.toString()}${result.stderr.toString()}`.trimEnd());
}
writeFileSync(path.join(out, "build.json"), JSON.stringify({ version, sign, notarized: notarize, timings, artifacts }, null, 2));
console.log(`[build-mac] done: ${out}\n${JSON.stringify(timings)}`);
