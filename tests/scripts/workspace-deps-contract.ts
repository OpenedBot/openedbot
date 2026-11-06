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
//
// Second pass (ADR 0001 S4): the declared @openedbot dependencies form no
// cycle. With the first pass, an import between two packages always follows
// a declared edge, so no package cycle can come back unnoticed (roster <->
// conversation, roster <-> portability, runtimes <-> runtime-link and
// identity -> execution -> roster -> identity were broken in S4).
// dependency-cruiser holds the same edges file by file
// (`module-par-ses-dependances`).
import { Glob } from "bun";

const ROOTS = ["apps", "modules", "platform", "contracts", "browser"];
const IMPORT = /(?:\bfrom|\bimport\(|^\s*import)\s*["'](@openedbot\/[a-z0-9-]+)/gm;

const failures: string[] = [];
const declaredEdges = new Map<string, string[]>();
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
    declaredEdges.set(pkg.name, [...declared].filter((name) => name.startsWith("@openedbot/") && name !== pkg.name));
    for (const file of new Glob("src/**/*.{ts,tsx}").scanSync(dir)) {
      const text = await Bun.file(`${dir}/${file}`).text();
      for (const match of text.matchAll(IMPORT)) {
        const used = match[1]!;
        if (used !== pkg.name && !declared.has(used)) failures.push(`${dir}/${file}: ${used} is not declared in ${manifest}`);
      }
    }
  }
}

/** Every cycle of the declared graph, each found once from its first package (depth-first). */
function declaredCycles(edges: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (name: string): void => {
    state.set(name, "open");
    path.push(name);
    for (const next of edges.get(name) ?? []) {
      if (!edges.has(next)) continue;
      if (state.get(next) === "open") cycles.push([...path.slice(path.indexOf(next)), next]);
      else if (!state.has(next)) visit(next);
    }
    path.pop();
    state.set(name, "done");
  };
  for (const name of [...edges.keys()].sort()) if (!state.has(name)) visit(name);
  return cycles;
}

for (const cycle of declaredCycles(declaredEdges)) {
  failures.push(`package cycle: ${cycle.join(" -> ")} (package.json dependencies)`);
}

if (failures.length > 0) {
  console.error([...new Set(failures)].join("\n"));
  console.error(`workspace-deps-contract: ${failures.length} failure(s). Declare every @openedbot import in the package.json (then bun install), and break any package cycle.`);
  process.exit(1);
}
console.log("workspace-deps-contract: every @openedbot import is declared by its workspace, and the declared packages form no cycle.");
