/**
 * `make license-check`: every third-party package the lockfile pins
 * (`bun.lock`, transitive included) under a licence the core may ship.
 *
 * Each `bun.lock` entry (`name@version`) is read back from its installed
 * manifest (`node_modules/.bun/<name>@<version>…/node_modules/<name>`), or
 * its LICENSE file when the manifest says nothing. Fails on:
 *   - a GPL or AGPL licence with no non-copyleft alternative (`MIT OR GPL-3.0`
 *     passes, `GPL-3.0` does not; LGPL is not GPL). The core is AGPL-3.0,
 *     but it is also sold under a commercial licence, which third-party
 *     copyleft code would forbid;
 *   - an installable entry whose licence cannot be read.
 * Lists LGPL and MPL packages (weak copyleft: allowed, to know about), and
 * the entries for other platforms, not installed here (`os`/`cpu` in the
 * lockfile), by name.
 *
 *   bun scripts/license-scan.ts [--json]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Entry = { key: string; name: string; version: string; platformOnly: boolean };
export type Verdict = Entry & { license: string | null; source: "manifest" | "license-file" | "absent" };

export function lockEntries(lockText: string): Entry[] {
  const lock = JSON.parse(lockText.replace(/,(\s*[}\]])/g, "$1")) as { packages: Record<string, unknown[]> };
  const entries: Entry[] = [];
  for (const [key, value] of Object.entries(lock.packages)) {
    const spec = String(value[0]);
    const at = spec.lastIndexOf("@");
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    if (!name || version.startsWith("workspace:")) continue;
    const meta = (value.find((part) => typeof part === "object" && part !== null && !Array.isArray(part)) ?? {}) as { os?: unknown; cpu?: unknown };
    entries.push({ key, name, version, platformOnly: meta.os !== undefined || meta.cpu !== undefined });
  }
  // A dependency nested under another platform's package (`<pkg>/<dep>`) is
  // installed only with it.
  const platformKeys = entries.filter((entry) => entry.platformOnly).map((entry) => `${entry.key}/`);
  return entries.map((entry) => ({ ...entry, platformOnly: entry.platformOnly || platformKeys.some((key) => entry.key.startsWith(key)) }));
}

export function normalize(license: unknown): string | null {
  if (typeof license === "string" && license.trim()) return license.trim();
  if (license && typeof license === "object" && "type" in license) return normalize((license as { type: unknown }).type);
  if (Array.isArray(license) && license.length > 0) {
    const parts = license.map(normalize).filter((part): part is string => part !== null);
    return parts.length ? `(${parts.join(" OR ")})` : null;
  }
  return null;
}

/** Best effort on a LICENSE file's opening words. */
export function licenseFromText(text: string): string | null {
  const head = text.slice(0, 600);
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(head)) return "AGPL (LICENSE file)";
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(head)) return "LGPL (LICENSE file)";
  if (/GNU GENERAL PUBLIC LICENSE/i.test(head)) return "GPL (LICENSE file)";
  if (/Mozilla Public License/i.test(head)) return "MPL (LICENSE file)";
  if (/Apache License/i.test(head)) return "Apache-2.0 (LICENSE file)";
  if (/\bMIT License\b|Permission is hereby granted, free of charge/i.test(head)) return "MIT (LICENSE file)";
  if (/\bISC License\b|Permission to use, copy, modify, and\/or distribute/i.test(head)) return "ISC (LICENSE file)";
  if (/BSD|Redistribution and use in source and binary forms/i.test(head)) return "BSD (LICENSE file)";
  return null;
}

const STRONG = /(^|[^L\w])A?GPL\b|^A?GPL|GNU (AFFERO )?GENERAL PUBLIC/i;
const WEAK = /\bLGPL|\bMPL\b|Mozilla/i;

/** True when every alternative of the expression is GPL or AGPL. */
export function isStrongCopyleft(license: string): boolean {
  const alternatives = license.replace(/[()]/g, " ").split(/\s+OR\s+/i);
  return alternatives.every((alternative) => STRONG.test(alternative.replace(/\bLGPL[-\w.+]*/gi, "")));
}

export function isWeakCopyleft(license: string): boolean {
  return WEAK.test(license);
}

function installedDir(root: string, entry: Entry, store: string[]): string | null {
  const prefix = `${entry.name.replace("/", "+")}@${entry.version}`;
  for (const dir of store) {
    if (dir === prefix || dir.startsWith(`${prefix}+`)) {
      const path = join(root, "node_modules/.bun", dir, "node_modules", entry.name);
      if (existsSync(join(path, "package.json"))) return path;
    }
  }
  return null;
}

export function scan(root: string): Verdict[] {
  const entries = lockEntries(readFileSync(join(root, "bun.lock"), "utf8"));
  const store = existsSync(join(root, "node_modules/.bun")) ? readdirSync(join(root, "node_modules/.bun")) : [];
  return entries.map((entry) => {
    const dir = installedDir(root, entry, store);
    if (!dir) return { ...entry, license: null, source: "absent" as const };
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { license?: unknown; licenses?: unknown };
    const declared = normalize(manifest.license) ?? normalize(manifest.licenses);
    if (declared) return { ...entry, license: declared, source: "manifest" as const };
    const file = readdirSync(dir).find((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name));
    const fromFile = file ? licenseFromText(readFileSync(join(dir, file), "utf8")) : null;
    return { ...entry, license: fromFile, source: fromFile ? "license-file" as const : "absent" as const };
  });
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const verdicts = scan(root);
  const strong = verdicts.filter((v) => v.license && isStrongCopyleft(v.license));
  const weak = verdicts.filter((v) => v.license && !isStrongCopyleft(v.license) && isWeakCopyleft(v.license));
  const otherPlatform = verdicts.filter((v) => v.source === "absent" && v.platformOnly);
  const unknown = verdicts.filter((v) => v.license === null && !v.platformOnly);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ total: verdicts.length, strong, weak, otherPlatform: otherPlatform.map((v) => v.key), unknown }, null, 2));
  }
  const tally = new Map<string, number>();
  for (const v of verdicts) if (v.license) tally.set(v.license, (tally.get(v.license) ?? 0) + 1);
  const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([license, n]) => `${license} ${n}`).join(", ");
  console.log(`[license-check] bun.lock : ${verdicts.length} paquets tiers, ${verdicts.length - otherPlatform.length - unknown.length} licences lues (${top}…)`);
  for (const v of weak) console.log(`[license-check] copyleft faible (autorisé) : ${v.name}@${v.version} ${v.license}`);
  if (otherPlatform.length > 0) console.log(`[license-check] ${otherPlatform.length} paquets d'une autre plateforme, non installés ici : ${[...new Set(otherPlatform.map((v) => v.name))].join(" ")}`);
  for (const v of strong) console.error(`[license-check] GPL/AGPL interdit dans le cœur : ${v.name}@${v.version} ${v.license} (${v.key})`);
  for (const v of unknown) console.error(`[license-check] licence illisible : ${v.name}@${v.version} (${v.key})`);
  if (strong.length > 0 || unknown.length > 0) process.exit(1);
  console.log("[license-check] aucune dépendance GPL ni AGPL, transitives comprises");
}
