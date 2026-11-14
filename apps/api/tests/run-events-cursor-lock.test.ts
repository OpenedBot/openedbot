import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Invariant: cursor lock before any INSERT into `run_events`.
 *
 * Rule: every `insert into run_events` must be preceded, in the SAME
 * transaction, by a `pg_advisory_xact_lock(hashtext(<org>), hashtext('openedbot-run-events-cursor'))`.
 *
 * Why: PostgreSQL runs in READ COMMITTED. Without this per-organization lock,
 * two concurrent transactions can obtain cursors (`sequence`) in
 * an order different from the order of their commits: a reader would then see
 * cursor 12 before cursor 11 is visible, and a client that resumes
 * from « 12 » would lose « 11 » forever. The lock serializes the writes
 * per organization: cursor order becomes commit order, and
 * `organizationCursor` (`modules/conversation/src/sql/organization-cursor.ts`,
 * read first in the snapshot transaction) like `RosterDto.cursor`
 * are safe lower bounds for `GET /api/events?cursor=`.
 *
 * This test is static (no Postgres): it walks the sources and requires,
 * for each occurrence of `insert into run_events`, the presence in the same
 * file, at an earlier position in the text, of either:
 *   - a `pg_advisory_xact_lock(` carrying the key `'openedbot-run-events-cursor'`
 *     (inline, as in the primitive `modules/execution/src/sql/run-events.ts`);
 *   - or a CALL to a helper whose name contains `lockRunEventCursor` or
 *     `RunEventCursorLock`. The helper's DEFINITION does not count: it is
 *     the call that takes the lock.
 *
 * Since S2c, the primitive is the only writer of `run_events`, and
 * `tests/scripts/run-events-contract.ts` guards it more strictly (writes,
 * `max(sequence)`, cursor key); this test remains the safety net for order.
 *
 * Accepted limits: "earlier in the file" is not "in the same
 * transaction": the test catches a plain omission (a new site without a lock, or
 * a lock taken in another file), not a lock taken in another
 * function of the same file. Comments are stripped before analysis so
 * a mere mention of the helper does not pass for a lock.
 */

export type UnlockedRunEventInsert = {
  /** Path as given to the analysis (relative to the repository for scanned files). */
  path: string;
  /** Line (1-based) of the `insert into run_events` with no earlier lock. */
  line: number;
};

const INSERT_PATTERN = /insert\s+into\s+run_events\b/giu;

/**
 * `pg_advisory_xact_lock(` followed, in the same statement (bounded window,
 * no `;` and no backtick, multi-line allowed), by the key `'openedbot-run-events-cursor'`.
 */
const INLINE_LOCK_PATTERN = /pg_advisory_xact_lock\s*\([^;`]{0,240}?['"]openedbot-run-events-cursor['"]/giu;

/** Call of a recognized helper: an identifier containing the fragment, followed by `(`. */
const HELPER_CALL_PATTERN = /\b[\w$]*(?:lockRunEventCursor|RunEventCursorLock)[\w$]*\s*\(/gu;

/** A definition (`function lockRunEventCursorTx(`) is not a call. */
const DEFINITION_PREFIX = /(?:function|async\s+function)\s*$/u;

/** Strips full-line `//` comments and `/* … *\/` blocks, keeping the newlines. */
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
 * Pure function: returns each `insert into run_events` of `source` that is not
 * preceded by any recognized cursor lock in the same text.
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

/** Counts the `insert into run_events` (locked or not): a guard against a pattern that would no longer match anything. */
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

    // The pattern must still find the known sites; otherwise the test no longer guards anything.
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
