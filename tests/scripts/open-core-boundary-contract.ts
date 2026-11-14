#!/usr/bin/env bun
// Offline contract (open-core boundary, 2026-11-13): what is sold lives in
// the private plug-ins, and nothing of it comes back into the public core.
//
// Paid, outside the core: the external WORM archive of the audit (an S3/R2
// client, its AUDIT_WORM_* variables), enterprise identity (SAML, SCIM), the
// staff back office and its assisted sessions' tooling, and any feature gated
// by a plug-in entitlement other than the instance's own. Free, in the core:
// the approval gate, the local audit hash chain and its verification, the
// SubscriptionPort with NO_SUBSCRIPTIONS.
//
// Scanned: the sources of apps/, modules/, platform/, contracts/ and browser/
// (scripts of the apps included). Not scanned: tests and fixtures (they check
// absences), db/migrations (applied in production, ownership tracked in
// db/ownership.json), the root scripts/ and docs.
//
// Rules, each a failure:
//   1. an S3 client in a file that is about the audit, or an AUDIT_WORM_* name;
//   2. `saml` or `scim` as a word;
//   3. `staff` or `impersonat`, outside the allow-list below;
//   4. `entitlements.has(<x>)` with <x> other than a `core.*` literal,
//      `billing.enforced` or `audit.anchor` (or their PRO_ENTITLEMENTS names).
//
// Only files tracked by git are scanned: git-ignored build output (a minified
// console-dist bundle) is not source. `OPEN_CORE_SCAN_ROOT` points it at
// another git tree (its mutation test).
import { Glob } from "bun";
import { existsSync } from "node:fs";

const ROOT = process.env.OPEN_CORE_SCAN_ROOT ?? ".";
const PATTERNS = [
  "apps/**/*.{ts,tsx,js,mjs,cjs,css,html,json,sh}",
  "modules/*/src/**/*.{ts,tsx,js,mjs,json}",
  "platform/*/src/**/*.{ts,tsx,js,mjs,json}",
  "contracts/*/src/**/*.{ts,tsx,js,mjs,json}",
  "browser/*/src/**/*.{ts,tsx,js,mjs,css,json}",
];
const SKIPPED = /(^|\/)(tests?|fixtures|__tests__|node_modules|dist|dev-dist|target|gen)\/|\.test\.[a-z]+$|(^|\/)package\.json$|(^|\/)tsconfig[^/]*\.json$/;

/**
 * Words the scan tolerates, each for a reason that is not a paid feature.
 * Global entries apply everywhere; the others only in their file.
 */
const ALLOWED: ReadonlyArray<{ readonly token: RegExp; readonly file?: string; readonly reason: string }> = [
  { token: /\bimpersonated_by_staff_user_id\b/g, reason: "the sessions column of migration 0029, applied in production: renaming it needs a migration; the core reads it as `assistedBy`" },
  { token: /\bimpersonation\b/g, reason: "the `/api/auth/me` field an assisted session sets, read by shipped clients (iOS app) and the console" },
  { token: /\bIMPERSONATION_READ_ONLY\b/g, reason: "a public API error code clients may match" },
  { token: /\bchiefOfStaff\b|\bchief-of-staff\b|\bChief of Staff\b/g, reason: "a field of the portable team file format, a role name unrelated to staff accounts" },
  { token: /\bstaff_(users|sessions)\b/g, file: "apps/api/src/application/dev-reset.ts", reason: "core-schema tables the dev reset must keep: sessions reference staff_users" },
  { token: /\bstaff\b/g, file: "modules/identity/src/sql/product-features.ts", reason: "the stored value of the assisted-only audience (0180), mapped to `assisted`" },
];

/** The `entitlements.has` arguments the core may test (`EntitlementSource`). */
const ALLOWED_ENTITLEMENT_ARGS = new Set([
  '"billing.enforced"', "'billing.enforced'", "PRO_ENTITLEMENTS.billingEnforced",
  '"audit.anchor"', "'audit.anchor'", "PRO_ENTITLEMENTS.auditAnchor",
]);
/** Generic gates that test whatever a plug-in declared, never a named feature. */
const ALLOWED_ENTITLEMENT_CALLS: ReadonlyArray<{ readonly file: string; readonly arg: string; readonly reason: string }> = [
  { file: "apps/api/src/index.ts", arg: "entitlement", reason: "the session gate of a plug-in mount: the entitlement its own manifest declares" },
];

const S3_CLIENT = /\bS3Client\b/;
const ABOUT_AUDIT = /audit/i;
const AUDIT_WORM_ENV = /\bAUDIT_WORM_[A-Z_]+\b/g;
const SSO_WORDS = /\b(saml|scim)\b/gi;
const STAFF_WORDS = /staff|impersonat/gi;
const ENTITLEMENT_HAS = /\bentitlements\.has\(\s*([^,)]+?)\s*[,)]/g;

const failures: string[] = [];
let scanned = 0;

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
/** Blanks a match, keeping its newlines, so the reported lines stay the file's. */
const blank = (match: string) => match.replace(/[^\n]/g, " ");

const listed = Bun.spawnSync(["git", "-C", ROOT, "ls-files", "-z"], { stdout: "pipe", stderr: "pipe" });
if (listed.exitCode !== 0) {
  console.error(`open-core-boundary-contract: \`git ls-files\` failed under ${ROOT} (a git tree is required): ${listed.stderr.toString().trim()}`);
  process.exit(2);
}
const tracked = listed.stdout.toString().split("\0").filter(Boolean);
const globs = PATTERNS.map((pattern) => new Glob(pattern));

for (const path of tracked) {
  // A tracked file deleted from the working tree has nothing to scan.
  if (!globs.some((glob) => glob.match(path)) || SKIPPED.test(path) || !existsSync(`${ROOT}/${path}`)) continue;
  scanned += 1;
  const text = await Bun.file(`${ROOT}/${path}`).text();

  if (S3_CLIENT.test(text) && (ABOUT_AUDIT.test(path) || ABOUT_AUDIT.test(text))) {
    failures.push(`${path}:${lineOf(text, text.search(S3_CLIENT))}: an S3/R2 client next to the audit (the external archive is the plug-in audit's)`);
  }
  for (const match of text.matchAll(AUDIT_WORM_ENV)) {
    failures.push(`${path}:${lineOf(text, match.index)}: names ${match[0]} (the archive's variables are the plug-in audit's manifest.env)`);
  }
  for (const match of text.matchAll(SSO_WORDS)) {
    failures.push(`${path}:${lineOf(text, match.index)}: names ${match[0]} (enterprise identity belongs to a plug-in)`);
  }

  let rest = text;
  for (const entry of ALLOWED) {
    if (entry.file && entry.file !== path) continue;
    rest = rest.replace(entry.token, blank);
  }
  for (const match of rest.matchAll(STAFF_WORDS)) {
    failures.push(`${path}:${lineOf(rest, match.index)}: names "${match[0]}" outside the allow-list (the back office belongs to a plug-in)`);
  }

  for (const match of text.matchAll(ENTITLEMENT_HAS)) {
    const arg = match[1]!.trim();
    const literal = /^(["'])core\.[a-z0-9_.-]+\1$/.test(arg);
    const generic = ALLOWED_ENTITLEMENT_CALLS.some((entry) => entry.file === path && entry.arg === arg);
    if (!literal && !generic && !ALLOWED_ENTITLEMENT_ARGS.has(arg)) {
      failures.push(`${path}:${lineOf(text, match.index)}: entitlements.has(${arg}) gates a feature on a plug-in entitlement (only core.*, billing.enforced, audit.anchor)`);
    }
  }
}

if (scanned === 0) {
  console.error(`open-core-boundary-contract: nothing scanned under ${ROOT}.`);
  process.exit(2);
}
if (failures.length > 0) {
  console.error(failures.sort().join("\n"));
  console.error(`open-core-boundary-contract: ${failures.length} finding(s). What is sold lives in the private plug-ins; extend the allow-list only with a reason that is not a paid feature.`);
  process.exit(1);
}
console.log(`open-core-boundary-contract: ok (${scanned} files)`);
