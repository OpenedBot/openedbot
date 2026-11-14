/**
 * Contract of the foreign table reads, offline (`make test-unit`). See
 * "Foreign reads and run writes" in docs/contributing/architecture.md.
 *
 * Every table has an owning context (`db/ownership.json`): a module
 * (`modules/<name>`), an application (`apps/<name>`) or a plug-in leaving the
 * core. A context reads its own tables; a read of a table another context
 * owns (`from` or `join` in the shipped SQL of `modules/*\/src` and
 * `apps/*\/src`, tests excluded) should go through the owner's application
 * layer instead. The reads that already exist are frozen per file and per
 * table in DEBT: a count may go down (`--record` lowers it), never up, and a
 * file or a table that is not listed may not start reading. Past the debt's
 * `until` date the contract warns, it does not fail.
 *
 * Writes are held by `tests/scripts/db-ownership-contract.sh` (owner or
 * declared writer). Comments are blanked before matching, so a sentence that
 * names a table is not a read. `delete from` is a write, not a read. Out of
 * reach: SQL built from a dynamic table name.
 *
 *   bun tests/scripts/foreign-reads-contract.ts [--record] [--root <dir>]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const root = rootFlag >= 0 ? resolve(args[rootFlag + 1] ?? ".") : resolve(import.meta.dir, "../..");
const recording = args.includes("--record");
const DEBT_FILE = join(root, "tests/scripts/foreign-reads-debt.json");

type OwnershipEntry = string | { owner: string; writers?: string[] };
type Debt = { until: string; reason: string; files: Record<string, Record<string, number>> };

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "tests" && entry !== "test") walk(path, out);
    } else if (/\.tsx?$/u.test(entry) && !/\.(test|bench)\.tsx?$|\.d\.ts$/u.test(entry)) {
      out.push(path);
    }
  }
}

/** Each shipped file with its context: `roster` for modules/roster, `apps/api` for apps/api. */
function sources(): Array<{ file: string; context: string }> {
  const files: Array<{ file: string; context: string }> = [];
  for (const layer of ["modules", "apps"]) {
    const base = join(root, layer);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base).sort()) {
      const found: string[] = [];
      walk(join(base, pkg, "src"), found);
      const context = layer === "modules" ? pkg : `apps/${pkg}`;
      for (const path of found) files.push({ file: relative(root, path), context });
    }
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

/** Comments blanked, newlines kept, so that line numbers stay those of the file. */
function code(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/gu, " ");
  return text.replace(/\/\*[\s\S]*?\*\//gu, blank).replace(/^[ \t]*\/\/.*$/gmu, blank);
}

const line = (text: string, index: number) => text.slice(0, index).split("\n").length;

const ownership = JSON.parse(readFileSync(join(root, "db/ownership.json"), "utf8")) as Record<string, OwnershipEntry>;
const owners = new Map<string, string>();
for (const [table, entry] of Object.entries(ownership)) {
  if (table.startsWith("$")) continue;
  owners.set(table, typeof entry === "string" ? entry : entry.owner);
}
// An unquoted identifier only: `from "./x"` in an import is not a read.
const READ = /\b(?<!\bdelete\s+)(?:from|join)\s+(?:public\.)?([a-z_][a-z0-9_]*)\b/giu;

const errors: string[] = [];
const counted: Record<string, Record<string, number>> = {};
const firstLine: Record<string, Record<string, number>> = {};

for (const { file, context } of sources()) {
  const text = code(readFileSync(join(root, file), "utf8"));
  for (const match of text.matchAll(READ)) {
    const table = match[1]!.toLowerCase();
    const owner = owners.get(table);
    if (owner === undefined || owner === context) continue;
    counted[file] ??= {};
    counted[file][table] = (counted[file][table] ?? 0) + 1;
    firstLine[file] ??= {};
    firstLine[file][table] ??= line(text, match.index);
  }
}

const debt = JSON.parse(readFileSync(DEBT_FILE, "utf8")) as Debt;
if (!/^\d{4}-\d{2}-\d{2}$/u.test(debt.until) || !debt.reason || typeof debt.files !== "object") {
  errors.push(`${relative(root, DEBT_FILE)} : until (AAAA-MM-JJ), reason et files sont requis.`);
}
if (recording) {
  const files: Debt["files"] = {};
  for (const [file, ceilings] of Object.entries(debt.files).sort(([a], [b]) => a.localeCompare(b))) {
    const kept: Record<string, number> = {};
    for (const [table, ceiling] of Object.entries(ceilings).sort(([a], [b]) => a.localeCompare(b))) {
      const now = Math.min(counted[file]?.[table] ?? 0, ceiling);
      if (now > 0) kept[table] = now;
    }
    if (Object.keys(kept).length) files[file] = kept;
  }
  debt.files = files;
  await Bun.write(DEBT_FILE, `${JSON.stringify(debt, null, 2)}\n`);
  console.log(`foreign-reads-contract: plafonds abaissés dans ${relative(root, DEBT_FILE)}.`);
}

for (const [file, tables] of Object.entries(counted).sort(([a], [b]) => a.localeCompare(b))) {
  for (const [table, now] of Object.entries(tables).sort(([a], [b]) => a.localeCompare(b))) {
    const allowed = debt.files[file]?.[table] ?? 0;
    if (now > allowed) {
      errors.push(
        `${file}:${firstLine[file]![table]} : ${now} lecture(s) de ${table} (propriétaire : ${owners.get(table)}) pour un plafond de ${allowed}. ` +
        "Lisez par la couche application du propriétaire ; une exception se justifie en revue, plafond relevé.",
      );
    }
  }
}
for (const [file, ceilings] of Object.entries(debt.files)) {
  for (const [table, ceiling] of Object.entries(ceilings)) {
    const now = counted[file]?.[table] ?? 0;
    if (now < ceiling) errors.push(`${file} : ${now} lecture(s) de ${table} pour un plafond de ${ceiling} ; constatez le gain avec --record.`);
  }
}
if (new Date(`${debt.until}T23:59:59Z`).getTime() < Date.now()) {
  console.error(`foreign-reads-contract: avertissement : cliquet échu depuis le ${debt.until} : ${debt.reason}`);
}

for (const message of errors) console.error(`foreign-reads-contract: ${message}`);
if (errors.length) process.exit(1);
const total = Object.values(counted).reduce((sum, tables) => sum + Object.values(tables).reduce((a, b) => a + b, 0), 0);
console.log(`foreign-reads-contract: ${total} lectures de tables étrangères dans ${Object.keys(counted).length} fichiers, toutes sous le cliquet (jusqu'au ${debt.until}).`);
