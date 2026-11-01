#!/usr/bin/env bun
// Offline contract: every @openedbot/* package imported by a workspace's src/ is
// declared in that workspace's package.json.
//
// Why: Bun hoists every workspace into the root node_modules, so an undeclared
// import still resolves on a dev machine, in `make typecheck` and in the tests.
// dependency-cruiser follows the symlink to the package's sources and sees a
// local file, not a dependency, so `make deps-check` cannot see it either. The
// container images install each app on its own: the preprod worker crashed on
// `Cannot find module '@openedbot/platform-db'` (2026-10-23) after a green CI.
import { Glob } from "bun";

const ROOTS = ["apps", "modules", "platform", "contracts", "browser"];
const IMPORT = /(?:\bfrom|\bimport\(|^\s*import)\s*["'](@openedbot\/[a-z0-9-]+)/gm;

const failures: string[] = [];
for (const root of ROOTS) {
  for (const manifest of new Glob(`${root}/*/package.json`).scanSync(".")) {
    const dir = manifest.slice(0, -"/package.json".length);
    const pkg = (await Bun.file(manifest).json()) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }));
    for (const file of new Glob("src/**/*.{ts,tsx}").scanSync(dir)) {
      const text = await Bun.file(`${dir}/${file}`).text();
      for (const match of text.matchAll(IMPORT)) {
        const used = match[1]!;
        if (used !== pkg.name && !declared.has(used)) failures.push(`${dir}/${file}: ${used} is not declared in ${manifest}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error([...new Set(failures)].join("\n"));
  console.error(`workspace-deps-contract: ${failures.length} undeclared @openedbot import(s). Add them to the package.json, then bun install.`);
  process.exit(1);
}
console.log("workspace-deps-contract: every @openedbot import is declared by its workspace.");
