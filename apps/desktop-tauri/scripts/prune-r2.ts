#!/usr/bin/env bun
/**
 * Keeps on R2 only the two newest desktop releases (operator rule of
 * 2026-11-13), run by hand by the operator once a release is complete:
 *
 *   bun apps/desktop-tauri/scripts/prune-r2.ts                      dry run: prints what it would delete
 *   bun apps/desktop-tauri/scripts/prune-r2.ts --apply              deletes it
 *   bun apps/desktop-tauri/scripts/prune-r2.ts --listing FILE.json  dry run on a recorded listing, offline
 *
 * (`make desktop-tauri-prune [TAURI_PRUNE_APPLY=1]`). Env for a live run:
 * CLOUDFLARE_API_TOKEN (an API token with Workers R2 Storage Edit on the
 * account: wrangler has no object listing, so this goes through the
 * Cloudflare R2 REST API), CF_ACCOUNT_ID, R2_BUCKET (default
 * openedbot-releases).
 *
 * "Newest" is by publication, never by version number: the history restarted
 * at 0.1.0 on 2026-11-12 while 1.1.4 was already published, so 0.1.0 is the
 * newest release although its number is lower. The publication time of a
 * release is the upload time (`last_modified`) of its `desktop/v<version>/
 * SHA256SUMS`, which release.ts's publication order uploads after every
 * other file of the version.
 *
 * Kept, whatever the order says: the version each channel's manifest
 * (`desktop/solo/{stable,beta}/latest.json`) names, so the stable release,
 * which the update canary installs as N-1 before the next stable promotion,
 * is never deleted while it is served. Never touched: anything outside
 * `desktop/v<version>/` (the manifests under `desktop/solo/`).
 *
 * It refuses (exit 2, nothing deleted) rather than guess: a listing error, a
 * directory under `desktop/` that is neither `solo/` nor `vX.Y.Z/`, a version
 * without SHA256SUMS (an upload in progress) or with an unreadable date, two
 * versions published at the same instant, fewer than two versions, a manifest
 * that cannot be read or names a version absent from the bucket. Inside a
 * deleted version, SHA256SUMS goes first, so a half-deleted release never
 * lists a file that is gone; running it again finishes the job.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { RELEASE_VERSION } from "./mac-identity";
import { CHANNELS, VARIANT, type Channel } from "./release";

export const KEEP = 2;
/** Directories of `desktop/` that hold no release: never candidates. */
export const NON_RELEASE_DIRS: ReadonlySet<string> = new Set([VARIANT]);

export type R2Object = { key: string; last_modified: string };
export type PruneInput = { objects: R2Object[]; channels: Record<Channel, string> };
export type PrunePlan = {
  /** Every release, newest publication first. */
  releases: { version: string; publishedAt: string }[];
  keep: string[];
  remove: string[];
  /** The keys to delete, each release's SHA256SUMS first. */
  keys: string[];
};

export class PruneRefused extends Error {}

/** Selects what to delete; throws PruneRefused instead of guessing. Pure. */
export function planDesktopPrune(input: PruneInput, keep = KEEP): PrunePlan {
  const releases = new Map<string, { sums: string | null; keys: string[] }>();
  for (const { key } of input.objects) {
    if (!key.startsWith("desktop/")) throw new PruneRefused(`the listing returned a key outside desktop/: ${key}`);
    const parts = key.slice("desktop/".length).split("/");
    if (parts.length < 2) continue; // a file at the root of desktop/: never a candidate
    const dir = parts[0]!;
    if (NON_RELEASE_DIRS.has(dir)) continue;
    const version = /^v(.+)$/.exec(dir)?.[1];
    if (!version || !RELEASE_VERSION.test(version) || /(^|\.)0\d/.test(version)) throw new PruneRefused(`unexpected directory in the listing: desktop/${dir}/`);
    const release = releases.get(version) ?? { sums: null, keys: [] };
    release.keys.push(key);
    releases.set(version, release);
  }
  for (const object of input.objects) {
    const match = /^desktop\/v([^/]+)\/SHA256SUMS$/.exec(object.key);
    if (match) releases.get(match[1]!)!.sums = object.last_modified;
  }

  const dated = [...releases].map(([version, release]) => {
    if (release.sums === null) throw new PruneRefused(`desktop/v${version}/ has no SHA256SUMS (an upload in progress?)`);
    const time = Date.parse(release.sums);
    if (!Number.isFinite(time)) throw new PruneRefused(`desktop/v${version}/SHA256SUMS has an unreadable date: ${JSON.stringify(release.sums)}`);
    return { version, time, publishedAt: new Date(time).toISOString() };
  });
  if (dated.length < keep) throw new PruneRefused(`the listing holds ${dated.length} release(s), fewer than ${keep}`);
  dated.sort((a, b) => b.time - a.time);
  for (let i = 1; i < dated.length; i++) {
    if (dated[i]!.time === dated[i - 1]!.time) throw new PruneRefused(`${dated[i - 1]!.version} and ${dated[i]!.version} were published at the same instant: order unknown`);
  }

  const served = new Set<string>();
  for (const channel of CHANNELS) {
    const version = input.channels[channel];
    if (typeof version !== "string" || !RELEASE_VERSION.test(version)) throw new PruneRefused(`the ${channel} manifest names no release: ${JSON.stringify(version)}`);
    if (!releases.has(version)) throw new PruneRefused(`the ${channel} manifest names ${version}, absent from the bucket`);
    served.add(version);
  }

  const kept = new Set([...dated.slice(0, keep).map((r) => r.version), ...served]);
  const remove = dated.filter((r) => !kept.has(r.version)).map((r) => r.version);
  for (const version of remove) if (served.has(version)) throw new PruneRefused(`refusing to delete ${version}, served by a channel`);
  const keys = remove.flatMap((version) => {
    const sums = `desktop/v${version}/SHA256SUMS`;
    return [sums, ...releases.get(version)!.keys.filter((key) => key !== sums).sort()];
  });
  return {
    releases: dated.map(({ version, publishedAt }) => ({ version, publishedAt })),
    keep: dated.filter((r) => kept.has(r.version)).map((r) => r.version),
    remove,
    keys,
  };
}

type Api = { base: string; auth: string };

async function call(api: Api, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${api.base}${path}`, { ...init, headers: { Authorization: `Bearer ${api.auth}`, ...(init.headers ?? {}) } });
}

/** Every object under `prefix`, every page. */
export async function listObjects(api: Api, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor = "";
  for (let page = 0; page < 1000; page++) {
    const query = new URLSearchParams({ prefix, per_page: "1000" });
    if (cursor) query.set("cursor", cursor);
    const response = await call(api, `?${query}`);
    const body = (await response.json().catch(() => null)) as {
      success?: boolean;
      errors?: unknown;
      result?: { key?: unknown; last_modified?: unknown }[];
      result_info?: { is_truncated?: boolean; cursor?: string };
    } | null;
    if (!response.ok || body?.success !== true || !Array.isArray(body.result)) throw new PruneRefused(`listing ${prefix} failed (HTTP ${response.status}): ${JSON.stringify(body?.errors ?? body)}`);
    for (const item of body.result) {
      if (typeof item.key !== "string") throw new PruneRefused(`listing ${prefix} returned an object without a key`);
      objects.push({ key: item.key, last_modified: typeof item.last_modified === "string" ? item.last_modified : "" });
    }
    if (!body.result_info?.is_truncated) return objects;
    cursor = body.result_info.cursor ?? "";
    if (!cursor) throw new PruneRefused(`listing ${prefix} is truncated without a cursor`);
  }
  throw new PruneRefused(`listing ${prefix} never ends`);
}

async function channelVersion(api: Api, channel: Channel): Promise<string> {
  const key = `desktop/${VARIANT}/${channel}/latest.json`;
  const response = await call(api, `/${key}`);
  if (!response.ok) throw new PruneRefused(`${key} could not be read (HTTP ${response.status})`);
  const manifest = (await response.json().catch(() => null)) as { version?: unknown } | null;
  return typeof manifest?.version === "string" ? manifest.version : "";
}

function printPlan(plan: PrunePlan, apply: boolean): void {
  for (const release of plan.releases) {
    console.log(`  ${plan.remove.includes(release.version) ? (apply ? "delete" : "would delete") : "keep"}  ${release.version}  (SHA256SUMS ${release.publishedAt})`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { apply: { type: "boolean", default: false }, listing: { type: "string" } }, strict: true });
  if (values.listing) {
    if (values.apply) throw new PruneRefused("--listing is a recorded listing: dry run only");
    const plan = planDesktopPrune(JSON.parse(readFileSync(values.listing, "utf8")) as PruneInput);
    console.log(`prune-r2 (dry run, ${values.listing}):`);
    printPlan(plan, false);
    for (const key of plan.keys) console.log(`  would delete ${key}`);
    if (plan.remove.length === 0) console.log("prune-r2: nothing to delete");
    return;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const account = process.env.CF_ACCOUNT_ID ?? "";
  if (!token || !account) throw new PruneRefused("CLOUDFLARE_API_TOKEN and CF_ACCOUNT_ID are required (an API token with Workers R2 Storage Edit)");
  const bucket = process.env.R2_BUCKET || "openedbot-releases";
  const api: Api = { base: `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects`, auth: token };
  const channels = { beta: await channelVersion(api, "beta"), stable: await channelVersion(api, "stable") };
  const plan = planDesktopPrune({ objects: await listObjects(api, "desktop/"), channels });
  console.log(`prune-r2 (${values.apply ? "apply" : "dry run"}, ${bucket}; stable ${channels.stable}, beta ${channels.beta}):`);
  printPlan(plan, values.apply);
  if (plan.remove.length === 0) {
    console.log("prune-r2: nothing to delete");
    return;
  }
  if (!values.apply) {
    for (const key of plan.keys) console.log(`  would delete ${key}`);
    console.log("prune-r2: dry run, nothing deleted (--apply to delete)");
    return;
  }
  for (const key of plan.keys) {
    const response = await call(api, `/${key}`, { method: "DELETE" });
    const body = (await response.json().catch(() => null)) as { success?: boolean; errors?: unknown } | null;
    if (!response.ok || body?.success !== true) throw new Error(`delete of ${key} failed (HTTP ${response.status}): ${JSON.stringify(body?.errors ?? body)}; run it again to finish`);
    console.log(`  deleted ${key}`);
  }
  for (const version of plan.remove) {
    const left = await listObjects(api, `desktop/v${version}/`);
    if (left.length > 0) throw new Error(`desktop/v${version}/ still holds ${left.length} object(s); run it again to finish`);
  }
  console.log(`prune-r2: deleted ${plan.remove.join(", ")}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`prune-r2: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof PruneRefused ? 2 : 1);
  });
}
