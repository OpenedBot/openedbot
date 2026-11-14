#!/usr/bin/env bun
// Offline contract: outside `apps/console/src/lib/platform/`, the console never
// reads the page origin (`location.origin`).
//
// Why: the console bundled in the desktop app is served
// from a local origin (`tauri://localhost`). A link built from the page origin
// (a shared link, a webhook URL, a page opened in the browser) would
// point at that local origin, which nobody else can open. `lib/platform` gives
// the public console origin (`publicConsoleOrigin`) and parses app paths
// without an origin (`appUrl`). Its sibling rule `console-plateforme-par-la-facade`
// (.dependency-cruiser.cjs) keeps the desktop bridge behind the same door.
import { Glob } from "bun";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SOURCE = "apps/console/src";
const ALLOWED = `${SOURCE}/lib/platform/`;
const FORBIDDEN = /\blocation\.origin\b/;

const offenders: string[] = [];
let scanned = 0;
for await (const file of new Glob(`${SOURCE}/**/*.{ts,tsx}`).scan({ cwd: ROOT })) {
  const path = relative(ROOT, resolve(ROOT, file));
  if (path.startsWith(ALLOWED)) continue;
  scanned++;
  const lines = (await Bun.file(resolve(ROOT, path)).text()).split("\n");
  lines.forEach((line, index) => {
    if (FORBIDDEN.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
  });
}

if (scanned === 0) {
  console.error(`console-platform-contract: no file scanned under ${SOURCE}; the contract would pass vacuously.`);
  process.exit(1);
}
if (offenders.length > 0) {
  console.error("console-platform-contract: the console reads the page origin outside lib/platform. Use publicConsoleOrigin(), publicConsoleUrl() or appUrl() from lib/platform:");
  for (const offender of offenders) console.error(`  ${offender}`);
  process.exit(1);
}
console.info(`console-platform-contract: OK (${scanned} files, no location.origin outside lib/platform).`);
