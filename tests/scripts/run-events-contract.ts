/**
 * Contract of the run event allocation primitive, offline (`make test-unit`).
 * Rule: a run event sequence number is allocated in one place only, so
 * concurrent producers never reuse or skip one.
 *
 * Strict, in the shipped code (`apps/*\/src`, `modules/*\/src`, `platform/*\/src`,
 * `scripts/`): only PRIMITIVE
 *
 *  1. writes `run_events` (`insert into run_events`, `update run_events`);
 *  2. computes `max(sequence)` (or `max(<alias>.sequence)`) in a statement
 *     that reads `run_events`: the next sequence is computed under the run's
 *     row lock and the cursor lock, in a statement after them, nowhere else;
 *  3. names the cursor lock key (`openedbot-run-events-cursor`).
 *
 * In `db/migrations`, no SQL inserts into `run_events`, and only the identity
 * backfill of 0092 updates it. `delete from run_events` (retention purge)
 * stays allowed: a deletion numbers nothing. Comments are blanked before
 * matching. Out of reach: SQL built from a dynamic table name, and a maximum
 * read another way (`order by sequence desc limit 1`), which the primitive's
 * check under its locks still refuses to reuse.
 *
 *   bun tests/scripts/run-events-contract.ts [--root <dir>]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const root = rootFlag >= 0 ? resolve(args[rootFlag + 1] ?? ".") : resolve(import.meta.dir, "../..");

const PRIMITIVE = "modules/execution/src/sql/run-events.ts";
const IDENTITY_BACKFILL = "0092_run_events_identity.sql";

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

function sources(): string[] {
  const files: string[] = [];
  for (const layer of ["apps", "modules", "platform"]) {
    const base = join(root, layer);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base)) walk(join(base, pkg, "src"), files);
  }
  walk(join(root, "scripts"), files);
  return files.map((file) => relative(root, file)).sort();
}

/** Comments blanked, newlines kept, so that line numbers stay those of the file. */
function code(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/gu, " ");
  return text.replace(/\/\*[\s\S]*?\*\//gu, blank).replace(/^[ \t]*\/\/.*$/gmu, blank);
}

const line = (text: string, index: number) => text.slice(0, index).split("\n").length;
/** The SQL statement around a match: its template literal, backtick to backtick. */
function statement(text: string, index: number): string {
  const start = text.lastIndexOf("`", index);
  const end = text.indexOf("`", index);
  return text.slice(start < 0 ? 0 : start, end < 0 ? undefined : end);
}

const WRITE = /\b(?:insert\s+into|update)\s+(?:public\.)?"?run_events"?\b/giu;
const MAX_SEQUENCE = /\bmax\s*\(\s*(?:"?\w+"?\.)?"?sequence"?\s*\)/giu;
const READS_RUN_EVENTS = /\brun_events\b/iu;
const CURSOR_KEY = /openedbot-run-events-cursor/gu;

const errors: string[] = [];
let primitiveSeen = false;

for (const file of sources()) {
  const text = code(readFileSync(join(root, file), "utf8"));
  if (file === PRIMITIVE) {
    primitiveSeen = true;
    continue;
  }
  for (const match of text.matchAll(WRITE)) {
    errors.push(`${file}:${line(text, match.index)} : « ${match[0]} » hors de la primitive d'allocation (${PRIMITIVE}). Passez par appendRunEventsTx (ou appendNumberedRunEventsTx pour le flux du worker).`);
  }
  for (const match of text.matchAll(MAX_SEQUENCE)) {
    if (READS_RUN_EVENTS.test(statement(text, match.index))) {
      errors.push(`${file}:${line(text, match.index)} : « ${match[0]} » sur run_events hors de la primitive (${PRIMITIVE}) : la séquence suivante se calcule sous le verrou du run puis du curseur, nulle part ailleurs.`);
    }
  }
  for (const match of text.matchAll(CURSOR_KEY)) {
    errors.push(`${file}:${line(text, match.index)} : verrou du curseur des événements pris hors de la primitive (${PRIMITIVE}) ; lockRunEventsTx le prend après le verrou du run.`);
  }
}
if (!primitiveSeen) errors.push(`${PRIMITIVE} est introuvable : la primitive d'allocation a disparu ou a été déplacée sans mettre ce contrat à jour.`);

const migrations = join(root, "db/migrations");
if (existsSync(migrations)) {
  for (const name of readdirSync(migrations).filter((entry) => entry.endsWith(".sql")).sort()) {
    const text = readFileSync(join(migrations, name), "utf8").replace(/--[^\n]*/gu, (comment) => " ".repeat(comment.length));
    for (const match of text.matchAll(WRITE)) {
      if (name === IDENTITY_BACKFILL && /^update/iu.test(match[0])) continue;
      errors.push(`db/migrations/${name}:${line(text, match.index)} : « ${match[0]} » ; aucune migration n'écrit run_events (seul le rattrapage d'identité ${IDENTITY_BACKFILL} le met à jour).`);
    }
  }
}

for (const message of errors) console.error(`run-events-contract: ${message}`);
if (errors.length) process.exit(1);
console.log(`run-events-contract: run_events écrit, séquences calculées et curseur verrouillé dans ${PRIMITIVE} seulement.`);
