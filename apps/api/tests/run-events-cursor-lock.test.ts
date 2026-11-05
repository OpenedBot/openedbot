import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Invariant Verrou de curseur avant tout INSERT dans `run_events`.
 *
 * Règle : tout `insert into run_events` doit être précédé, dans la MÊME
 * transaction, d'un `pg_advisory_xact_lock(hashtext(<org>), hashtext('openedbot-run-events-cursor'))`.
 *
 * Pourquoi : PostgreSQL tourne en READ COMMITTED. Sans ce verrou d'organisation,
 * deux transactions concurrentes peuvent obtenir des curseurs (`sequence`) dans
 * un ordre différent de l'ordre de leurs commits : un lecteur verrait alors le
 * curseur 12 avant que le curseur 11 ne soit visible, et un client qui repart
 * de « 12 » perdrait « 11 » pour toujours. Le verrou sérialise les écritures
 * par organisation : l'ordre des curseurs devient l'ordre des commits, et
 * `organizationCursor` (`modules/conversation/src/sql/organization-cursor.ts`,
 * lu en premier dans la transaction du snapshot) comme `RosterDto.cursor`
 * sont des bornes basses sûres pour `GET /api/events?cursor=`.
 *
 * Ce test est statique (aucun Postgres) : il parcourt les sources et exige,
 * pour chaque occurrence d'`insert into run_events`, la présence dans le même
 * fichier, à une position antérieure dans le texte, soit :
 *   - d'un `pg_advisory_xact_lock(` portant la clé `'openedbot-run-events-cursor'`
 *     (inline ou dans une CTE SQL, comme `modules/execution/src/application/queue.ts`) ;
 *   - soit d'un APPEL à un helper dont le nom contient `lockRunEventCursor` ou
 *     `RunEventCursorLock` (comme `lockRunEventCursorTx` dans
 *     `modules/execution/src/application/runner/events.ts`). La DÉFINITION du helper ne
 *     compte pas : c'est l'appel qui prend le verrou.
 *
 * Limites assumées : « antérieur dans le fichier » n'est pas « dans la même
 * transaction » : le test attrape l'oubli franc (nouveau site sans verrou, ou
 * verrou pris dans un autre fichier), pas un verrou pris dans une autre
 * fonction du même fichier. Les commentaires sont retirés avant l'analyse pour
 * qu'une simple mention du helper ne passe pas pour un verrou.
 */

export type UnlockedRunEventInsert = {
  /** Chemin tel que fourni à l'analyse (relatif au dépôt pour les fichiers scannés). */
  path: string;
  /** Ligne (1-based) de l'`insert into run_events` sans verrou antérieur. */
  line: number;
};

const INSERT_PATTERN = /insert\s+into\s+run_events\b/giu;

/**
 * `pg_advisory_xact_lock(` suivi, dans la même instruction (fenêtre bornée,
 * sans `;` ni backtick, multi-ligne autorisé), de la clé `'openedbot-run-events-cursor'`.
 */
const INLINE_LOCK_PATTERN = /pg_advisory_xact_lock\s*\([^;`]{0,240}?['"]openedbot-run-events-cursor['"]/giu;

/** Appel d'un helper reconnu : identifiant contenant le fragment, suivi de `(`. */
const HELPER_CALL_PATTERN = /\b[\w$]*(?:lockRunEventCursor|RunEventCursorLock)[\w$]*\s*\(/gu;

/** Une définition (`function lockRunEventCursorTx(`) n'est pas un appel. */
const DEFINITION_PREFIX = /(?:function|async\s+function)\s*$/u;

/** Retire les commentaires `//` de pleine ligne et les blocs `/* … *\/` en conservant les retours ligne. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " "))
    .replace(/^[ \t]*\/\/[^\n]*/gmu, (line) => " ".repeat(line.length));
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function lockPositions(source: string): number[] {
  const positions: number[] = [];
  for (const match of source.matchAll(INLINE_LOCK_PATTERN)) {
    positions.push(match.index);
  }
  for (const match of source.matchAll(HELPER_CALL_PATTERN)) {
    if (DEFINITION_PREFIX.test(source.slice(0, match.index))) continue;
    positions.push(match.index);
  }
  return positions.sort((a, b) => a - b);
}

/**
 * Fonction pure : rend chaque `insert into run_events` de `source` qui n'est
 * précédé d'aucun verrou de curseur reconnu dans le même texte.
 */
export function findUnlockedRunEventInserts(source: string, path: string): UnlockedRunEventInsert[] {
  const text = stripComments(source);
  const locks = lockPositions(text);
  const unlocked: UnlockedRunEventInsert[] = [];
  for (const match of text.matchAll(INSERT_PATTERN)) {
    const hasEarlierLock = locks.some((position) => position < match.index);
    if (!hasEarlierLock) {
      unlocked.push({ path, line: lineOf(text, match.index) });
    }
  }
  return unlocked;
}

/** Compte les `insert into run_events` (verrouillés ou non) : garde-fou contre un motif qui ne matcherait plus rien. */
export function countRunEventInserts(source: string): number {
  return [...stripComments(source).matchAll(INSERT_PATTERN)].length;
}

function listTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      files.push(...listTypeScriptFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
    files.push(full);
  }
  return files.sort();
}

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNED_ROOTS = ["apps/api/src", "apps/worker/src", "modules"] as const;

describe("Verrou de curseur avant chaque insert dans run_events", () => {
  test("chaque `insert into run_events` des sources est précédé d'un verrou d'organisation dans son fichier", () => {
    const failures: UnlockedRunEventInsert[] = [];
    let insertsSeen = 0;

    for (const root of SCANNED_ROOTS) {
      for (const file of listTypeScriptFiles(join(REPO_ROOT, root))) {
        const source = readFileSync(file, "utf8");
        const relative = file.slice(REPO_ROOT.length);
        insertsSeen += countRunEventInserts(source);
        failures.push(...findUnlockedRunEventInserts(source, relative));
      }
    }

    // Le motif doit encore trouver les sites connus ; sinon le test ne garde plus rien.
    expect(insertsSeen).toBeGreaterThan(0);

    const report = failures.map((failure) => `  - ${failure.path}:${failure.line}`).join("\n");
    expect(
      failures,
      `insert into run_events sans pg_advisory_xact_lock(hashtext(<org>), hashtext('openedbot-run-events-cursor')) antérieur dans le même fichier :\n${report}\n` +
        "Voir modules/conversation/src/sql/organization-cursor.ts (borne basse sous READ COMMITTED).",
    ).toEqual([]);
  });

  test("un insert sans verrou est détecté avec son fichier et sa ligne", () => {
    const fixture = [
      "export async function record(tx, organizationId) {",
      "  await tx`",
      "    INSERT INTO run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at)",
      "    values (${organizationId}, ${threadId}, ${runId}, 1, 'x', '{}', now())",
      "  `;",
      "}",
    ].join("\n");

    expect(findUnlockedRunEventInserts(fixture, "fixture/unlocked.ts")).toEqual([
      { path: "fixture/unlocked.ts", line: 3 },
    ]);
  });

  test("un verrou placé APRÈS l'insert ne compte pas", () => {
    const fixture = [
      "await tx`insert into run_events (organization_id) values (${org})`;",
      "await tx`select pg_advisory_xact_lock(hashtext(${org}), hashtext('openedbot-run-events-cursor'))`;",
    ].join("\n");

    expect(findUnlockedRunEventInserts(fixture, "fixture/late.ts")).toEqual([{ path: "fixture/late.ts", line: 1 }]);
  });

  test("le verrou inline multi-ligne avant l'insert est reconnu", () => {
    const fixture = [
      "await tx`select pg_advisory_xact_lock(",
      "  hashtext(${auth.organizationId}), hashtext('openedbot-run-events-cursor')",
      ")`;",
      "await tx`",
      "  insert   into",
      "  run_events (organization_id) values (${org})`;",
    ].join("\n");

    expect(findUnlockedRunEventInserts(fixture, "fixture/inline.ts")).toEqual([]);
  });

  test("le verrou en CTE SQL (`… as locked`) avant l'insert est reconnu", () => {
    const fixture = [
      "await sql`",
      "  with locked as (",
      "    select pg_advisory_xact_lock(hashtext(organization_id::text), hashtext('openedbot-run-events-cursor')) as locked",
      "    from runs where id = ${runId}",
      "  )",
      "  insert into run_events (organization_id) select organization_id from locked",
      "`;",
    ].join("\n");

    expect(findUnlockedRunEventInserts(fixture, "fixture/cte.ts")).toEqual([]);
  });

  test("l'appel d'un helper `lockRunEventCursor*` avant l'insert est reconnu, sa seule définition ne l'est pas", () => {
    const withCall = [
      "await lockRunEventCursorTx(tx, organizationId);",
      "await tx`insert into run_events (organization_id) values (${org})`;",
      "async function lockRunEventCursorTx(tx, organizationId) {",
      "  await tx`select pg_advisory_xact_lock(hashtext(${organizationId}), hashtext('openedbot-run-events-cursor'))`;",
      "}",
    ].join("\n");
    expect(findUnlockedRunEventInserts(withCall, "fixture/helper-call.ts")).toEqual([]);

    const definitionOnly = [
      "async function lockRunEventCursorTx(tx, organizationId) {",
      "  await tx`select 1`;",
      "}",
      "await tx`insert into run_events (organization_id) values (${org})`;",
    ].join("\n");
    expect(findUnlockedRunEventInserts(definitionOnly, "fixture/helper-def.ts")).toEqual([
      { path: "fixture/helper-def.ts", line: 4 },
    ]);
  });

  test("une mention du helper en commentaire ne vaut pas verrou", () => {
    const fixture = [
      "// comme `lockRunEventCursorTx(` dans runner.ts",
      "/* pg_advisory_xact_lock(hashtext(o), hashtext('openedbot-run-events-cursor')) */",
      "await tx`insert into run_events (organization_id) values (${org})`;",
    ].join("\n");

    expect(findUnlockedRunEventInserts(fixture, "fixture/comment.ts")).toEqual([{ path: "fixture/comment.ts", line: 3 }]);
  });
});
