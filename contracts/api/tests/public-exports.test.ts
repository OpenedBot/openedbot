import { expect, test } from "bun:test";
import { resolve } from "node:path";
import ts from "typescript";
import * as contracts from "../src/index";

/**
 * L'API publique de `@openedbot/contracts-api`, figée : chaque nom exporté
 * par `src/index.ts`, type ou valeur. Le découpage de `api.ts` par domaine
 * déplace des déclarations ; ce test prouve qu'aucun nom n'a disparu, changé
 * de nature (type ↔ valeur) ou été ajouté sans le vouloir.
 *
 * Un ajout ou un retrait voulu : `UPDATE_PUBLIC_EXPORTS=1 bun test tests/public-exports.test.ts`.
 */
const root = resolve(import.meta.dir, "..");
const snapshotPath = resolve(import.meta.dir, "public-exports.snapshot.txt");

function publicExports(): string[] {
  const entry = resolve(root, "src/index.ts");
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error("src/index.ts is not in the program");
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error("src/index.ts has no module symbol");
  return checker.getExportsOfModule(moduleSymbol).map((symbol) => {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const isValue = (target.flags & ts.SymbolFlags.Value) !== 0;
    return `${isValue ? "value" : "type"} ${symbol.name}`;
  }).sort();
}

test("the public exports of @openedbot/contracts-api do not move", async () => {
  const current = publicExports();
  if (process.env.UPDATE_PUBLIC_EXPORTS === "1") {
    await Bun.write(snapshotPath, `${current.join("\n")}\n`);
  }
  const frozen = (await Bun.file(snapshotPath).text()).trim().split("\n");
  expect(current).toEqual(frozen);
});

test("every exported value exists at run time", () => {
  const values = publicExports().filter((line) => line.startsWith("value ")).map((line) => line.slice(6));
  const missing = values.filter((name) => !(name in contracts));
  expect(missing).toEqual([]);
});

test("each domain is importable on its own, and the root serves the union", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const src = resolve(root, "src");
  const domains = readdirSync(src).filter((entry) => statSync(resolve(src, entry)).isDirectory());
  const union = new Set<string>();
  for (const domain of domains) {
    const module = await import(`@openedbot/contracts-api/${domain}`) as Record<string, unknown>;
    for (const [name, value] of Object.entries(module)) {
      expect([domain, name, (contracts as Record<string, unknown>)[name] === value]).toEqual([domain, name, true]);
      union.add(name);
    }
  }
  expect([...union].sort()).toEqual(Object.keys(contracts).sort());
});
