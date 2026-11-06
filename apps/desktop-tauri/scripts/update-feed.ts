#!/usr/bin/env bun
/**
 * The local update feed of the prototype (ADR 0001, D2a): a Bun static server
 * on loopback and the command that "publishes" a built version into it. It
 * stands in for the future hosted feed (Q2: R2 behind a stable URL): nothing
 * here leaves this Mac.
 *
 *   bun apps/desktop-tauri/scripts/update-feed.ts serve [--port 8799]
 *   bun apps/desktop-tauri/scripts/update-feed.ts publish --version 0.0.2
 *   bun apps/desktop-tauri/scripts/update-feed.ts publish --version 0.0.2 --announce 0.0.3 --forged-signature
 *
 * `publish` copies `release/<version>/*.app.tar.gz{,.sig}` into
 * `release/feed/<version>/` and writes `release/feed/latest.json`.
 * `--forged-signature` signs the artifact with a throwaway key instead of the
 * update key: the installed app must refuse it and keep its version.
 */
import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const APP_DIR = path.resolve(import.meta.dir, "..");
const RELEASE = path.join(APP_DIR, "release");
const FEED = path.join(RELEASE, "feed");
const ARTIFACT_STEM = "openedbot-preview";
const TARGET = "darwin-aarch64";

export type UpdateManifest = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
};

/** The manifest `tauri-plugin-updater` reads (static JSON format). */
export function buildManifest(input: { version: string; url: string; signature: string; notes: string; pubDate: Date }): UpdateManifest {
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(input.version)) throw new Error(`invalid version ${input.version}`);
  const signature = input.signature.trim();
  if (!signature) throw new Error("empty signature");
  return {
    version: input.version,
    notes: input.notes,
    pub_date: input.pubDate.toISOString(),
    platforms: { [TARGET]: { signature, url: input.url } },
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

function serve(port: number): void {
  mkdirSync(FEED, { recursive: true });
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const file = feedFile(FEED, url.pathname);
      const found = file !== null && existsSync(file) && Bun.file(file).size > 0;
      console.log(JSON.stringify({ at: new Date().toISOString(), method: request.method, path: url.pathname, status: found ? 200 : 404, agent: request.headers.get("user-agent") }));
      if (!found || request.method !== "GET") return new Response("not found", { status: 404 });
      // The manifest must never be cached: a stale one would hide a release.
      const headers = file.endsWith(".json") ? { "Cache-Control": "no-store", "Content-Type": "application/json" } : {};
      return new Response(Bun.file(file), { headers });
    },
  });
  console.log(`update feed on http://127.0.0.1:${port}/latest.json (${FEED})`);
}

async function publish(options: { version: string; announce: string; forged: boolean; port: number }): Promise<void> {
  const artifact = `${ARTIFACT_STEM}_${options.version}_aarch64.app.tar.gz`;
  const source = path.join(RELEASE, options.version, artifact);
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
    notes: options.forged ? "D2a: forged signature, must be refused" : `D2a prototype ${options.announce}`,
    pubDate: new Date(),
  });
  writeFileSync(path.join(FEED, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`published ${options.announce}${options.forged ? " (forged signature)" : ""} -> ${path.join(FEED, "latest.json")}`);
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", default: "8799" },
      version: { type: "string" },
      announce: { type: "string" },
      "forged-signature": { type: "boolean", default: false },
    },
  });
  const port = Number(values.port);
  if (positionals[0] === "serve") serve(port);
  else if (positionals[0] === "publish" && values.version) {
    await publish({ version: values.version, announce: values.announce ?? values.version, forged: values["forged-signature"] ?? false, port });
  } else {
    console.error("usage: update-feed.ts serve [--port N] | publish --version X.Y.Z [--announce X.Y.Z] [--forged-signature]");
    process.exit(1);
  }
}
