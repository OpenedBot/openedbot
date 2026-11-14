/**
 * Contract of the run write primitives, offline (`make test-unit`).
 * Rule: every physical write of `runs` goes through one named primitive, so
 * the run invariants are enforced in one place.
 *
 * 1. Creation, strict. In the shipped code (`apps/*\/src`, `modules/*\/src`,
 *    `platform/*\/src`, `scripts/`), `insert into runs`, `insert into
 *    workflows`, `delete from runs|workflows` and a workflow step claim (an
 *    `update workflows` that sets `used_steps` or `used_handoffs`) appear only
 *    in PRIMITIVES. In `db/migrations`, an insert into runs or workflows
 *    appears only in the review trigger's migrations (REVIEW_TRIGGER).
 * 2. Privacy, strict. Only COMMANDS import the primitives (also held by the
 *    dependency-cruiser rule `primitives-de-creation-privees`).
 * 3. Run transitions, strict (S2d). `update runs` appears only in
 *    TRANSITIONS (the transition function, sole writer of `status`,
 *    `external_state` and `remote_stop_state`, with its fencing) and in
 *    COLUMNS (named writes of the other columns), and COLUMNS never names one
 *    of the three columns in an assignment or a comparison (`=`). In
 *    `db/migrations`, no statement assigns them on `runs`.
 * 4. Workflow writes, dated ratchet. Every other `update workflows` (its
 *    status and the columns that travel with it) is counted per file in
 *    DEBT, until a transition function of workflows takes them. A count may
 *    go down (`--record` lowers it), never up; a file that is not listed may
 *    not start writing. Past the debt's `until` date the contract warns, it
 *    does not fail.
 *
 * Comments are blanked before matching, so a sentence that names a statement
 * is not a write. Out of reach: SQL built from a dynamic table name.
 *
 *   bun tests/scripts/run-writes-contract.ts [--record] [--root <dir>]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const root = rootFlag >= 0 ? resolve(args[rootFlag + 1] ?? ".") : resolve(import.meta.dir, "../..");
const recording = args.includes("--record");

const PRIMITIVES = "modules/execution/src/sql/run-writes.ts";
const TRANSITIONS = "modules/execution/src/sql/run-transitions.ts";
const COLUMNS = "modules/execution/src/sql/run-columns.ts";
const TRANSITION_COLUMNS = /\b(?:status|external_state|remote_stop_state)\s*=(?!=)/u;
const COMMANDS = new Set([
  "modules/execution/src/application/run-creation.ts",
  "modules/execution/src/application/runner/workflow-steps.ts",
]);
const REVIEW_TRIGGER = new Set(["0091_run_admission_envelope.sql", "0175_review_path_for_every_unknown_run.sql"]);
const DEBT_FILE = join(root, "tests/scripts/run-writes-debt.json");

type Debt = { until: string; step: string; reason: string; files: Record<string, { workflows?: number }> };

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
/** The SQL statement of a match: up to the end of its template literal. */
function statement(text: string, index: number): string {
  const end = text.indexOf("`", index);
  return text.slice(index, end < 0 ? undefined : end);
}

const CREATE = /\b(?:insert\s+into|delete\s+from)\s+(?:public\.)?"?(runs|workflows)"?\b/giu;
const UPDATE = /\bupdate\s+(?:public\.)?"?(runs|workflows)"?\b/giu;
const STEP_CLAIM = /\b(?:used_steps|used_handoffs)\s*=/u;
const IMPORTS_PRIMITIVES = /from\s+["'][^"']*sql\/run-writes(?:\.ts)?["']/u;

const errors: string[] = [];
const counted: Record<string, { workflows: number }> = {};

for (const file of sources()) {
  const text = code(readFileSync(join(root, file), "utf8"));
  const primitive = file === PRIMITIVES;
  for (const match of text.matchAll(CREATE)) {
    if (!primitive) {
      errors.push(`${file}:${line(text, match.index)} : « ${match[0]} » hors des primitives de création (${PRIMITIVES}). Passez par une commande de modules/execution (run-creation.ts, runner/workflow-steps.ts).`);
    }
  }
  for (const match of text.matchAll(UPDATE)) {
    const table = match[1]!.toLowerCase() as "runs" | "workflows";
    if (table === "workflows" && STEP_CLAIM.test(statement(text, match.index))) {
      if (!primitive) {
        errors.push(`${file}:${line(text, match.index)} : compte d'étapes d'un workflow (used_steps / used_handoffs) hors de claimWorkflowStepTx (${PRIMITIVES}).`);
      }
      continue;
    }
    if (primitive) continue;
    if (table === "runs") {
      if (file !== TRANSITIONS && file !== COLUMNS) {
        errors.push(`${file}:${line(text, match.index)} : « ${match[0]} » hors de la fonction de transition (${TRANSITIONS}) et des écritures nommées (${COLUMNS}). Une transition passe par transitionRuns ; une autre colonne, par une écriture nommée.`);
      }
      continue;
    }
    counted[file] ??= { workflows: 0 };
    counted[file].workflows += 1;
  }
  if (file === COLUMNS) {
    const assigned = TRANSITION_COLUMNS.exec(text);
    if (assigned) {
      errors.push(`${file}:${line(text, assigned.index)} : « ${assigned[0]} » ; status, external_state et remote_stop_state ne s'écrivent ni ne se comparent ici : seule la fonction de transition (${TRANSITIONS}) les touche.`);
    }
  }
  if (IMPORTS_PRIMITIVES.test(text) && !primitive && !COMMANDS.has(file)) {
    errors.push(`${file} : importe les primitives privées ${PRIMITIVES} ; seules les commandes (${[...COMMANDS].join(", ")}) les importent.`);
  }
}

const migrations = join(root, "db/migrations");
if (existsSync(migrations)) {
  for (const name of readdirSync(migrations).filter((entry) => entry.endsWith(".sql")).sort()) {
    const text = readFileSync(join(migrations, name), "utf8").replace(/--[^\n]*/gu, "");
    for (const match of text.matchAll(/\binsert\s+into\s+(?:public\.)?"?(runs|workflows)"?\b/giu)) {
      if (!REVIEW_TRIGGER.has(name)) {
        errors.push(`db/migrations/${name}:${line(text, match.index)} : « ${match[0]} » ; seul le trigger de revue (${[...REVIEW_TRIGGER].join(", ")}) crée un workflow en SQL.`);
      }
    }
    for (const match of text.matchAll(/\bupdate\s+(?:public\.)?"?runs"?\b[^;]*/giu)) {
      const set = /\bset\b([\s\S]*?)(?:\bwhere\b|$)/iu.exec(match[0])?.[1] ?? "";
      if (TRANSITION_COLUMNS.test(set)) {
        errors.push(`db/migrations/${name}:${line(text, match.index)} : une migration écrit status, external_state ou remote_stop_state de runs ; ces transitions passent par ${TRANSITIONS}.`);
      }
    }
  }
}

// 4. The ratchet of workflow writes.
const debt = JSON.parse(readFileSync(DEBT_FILE, "utf8")) as Debt;
if (!/^\d{4}-\d{2}-\d{2}$/u.test(debt.until) || !debt.step || !debt.reason) {
  errors.push(`${relative(root, DEBT_FILE)} : until (AAAA-MM-JJ), step et reason sont requis.`);
}
if (recording) {
  const files: Debt["files"] = {};
  for (const [file, ceiling] of Object.entries(debt.files).sort(([a], [b]) => a.localeCompare(b))) {
    const workflows = Math.min(counted[file]?.workflows ?? 0, ceiling.workflows ?? 0);
    if (workflows > 0) files[file] = { workflows };
  }
  debt.files = files;
  await Bun.write(DEBT_FILE, `${JSON.stringify(debt, null, 2)}\n`);
  console.log(`run-writes-contract: plafonds abaissés dans ${relative(root, DEBT_FILE)}.`);
}
for (const [file, now] of Object.entries(counted).sort(([a], [b]) => a.localeCompare(b))) {
  const allowed = debt.files[file]?.workflows ?? 0;
  if (now.workflows > allowed) {
    errors.push(`${file} : ${now.workflows} « update workflows » pour un plafond de ${allowed} (cliquet ${debt.step}). Une écriture nouvelle attend la fonction de transition des workflows ; sinon justifiez-la et relevez le plafond en revue.`);
  }
}
for (const [file, ceiling] of Object.entries(debt.files)) {
  if ("runs" in ceiling) errors.push(`${file} : plafond « runs » dans le cliquet ; les écritures de runs sont strictes depuis S2d, retirez-le.`);
  const now = counted[file] ?? { workflows: 0 };
  if (now.workflows < (ceiling.workflows ?? 0)) {
    errors.push(`${file} : moins d'écritures que le plafond (${now.workflows} workflows) ; constatez-le avec --record.`);
  }
}
if (new Date(`${debt.until}T23:59:59Z`).getTime() < Date.now()) {
  console.error(`run-writes-contract: avertissement : cliquet ${debt.step} échu depuis le ${debt.until} : ${debt.reason}`);
}

for (const message of errors) console.error(`run-writes-contract: ${message}`);
if (errors.length) process.exit(1);
const total = Object.values(counted).reduce((sum, now) => sum + now.workflows, 0);
console.log(`run-writes-contract: créations de runs et workflows dans ${PRIMITIVES} seulement ; transitions de runs dans ${TRANSITIONS} seulement ; ${total} écritures de workflows sous le cliquet ${debt.step} (jusqu'au ${debt.until}).`);
