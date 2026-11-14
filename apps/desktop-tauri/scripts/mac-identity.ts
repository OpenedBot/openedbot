/**
 * The two builds of the desktop app, twin of
 * `src-tauri/src/identity.rs`: the preview, which installs next to the
 * released app, and the production app (`app.openedbot.desktop`,
 * « openedbot », `openedbot://`). Shared by `build-mac.ts`, `build-linux.ts`,
 * `update-feed.ts` and `release.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const IDENTITIES = {
  preview: { product: "openedbot preview", stem: "openedbot-preview", bundleId: "app.openedbot.desktop.preview", executable: "openedbot-desktop-preview", overlay: null, scheme: null },
  production: { product: "openedbot", stem: "openedbot", bundleId: "app.openedbot.desktop", executable: "openedbot", overlay: "tauri.production.conf.json", scheme: "openedbot" },
} as const;
export type IdentityName = keyof typeof IDENTITIES;
export type Identity = (typeof IDENTITIES)[IdentityName];

/** X.Y.Z, or X.Y.Z-tag for a test build (semver: 1.1.1-test sorts after 1.1.0). */
export const BUILD_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
/** A release: X.Y.Z only, never a test suffix. */
export const RELEASE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

const isObject = (item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item);

/** Merges `overlay` into `base`: objects key by key, anything else replaced (Tauri's `--config` merge). */
export function mergeConfig(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    merged[key] = isObject(current) && isObject(value) ? mergeConfig(current, value) : value;
  }
  return merged;
}

/** The identity's overlay (`src-tauri/<overlay>`), without its `$schema`; empty for the preview. */
export function identityOverlay(appDir: string, identity: Identity): Record<string, unknown> {
  if (!identity.overlay) return {};
  const { $schema: _schema, ...overlay } = JSON.parse(readFileSync(path.join(appDir, "src-tauri", identity.overlay), "utf8")) as Record<string, unknown>;
  return overlay;
}

/** The artifact names of a build: `<stem>_<version>_aarch64.{dmg,app.tar.gz}`. */
export function artifactNames(identity: Identity, version: string): { dmg: string; tarball: string } {
  return { dmg: `${identity.stem}_${version}_aarch64.dmg`, tarball: `${identity.stem}_${version}_aarch64.app.tar.gz` };
}

export type LinuxArch = "x86_64" | "aarch64";

/** The Linux artifact names of a build: `<stem>_<version>_<arch>.{deb,AppImage}`. */
export function linuxArtifactNames(identity: Identity, version: string, arch: LinuxArch): { deb: string; appimage: string } {
  return { deb: `${identity.stem}_${version}_${arch}.deb`, appimage: `${identity.stem}_${version}_${arch}.AppImage` };
}
