import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "run-events-contract.ts");
const roots: string[] = [];

/** A minimal tree the contract accepts: the primitive, a `max` over messages, a retention purge, the 0092 backfill. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "run-events-contract-"));
  roots.push(root);
  const files: Record<string, string> = {
    "modules/execution/src/sql/run-events.ts": [
      "export const lock = (tx: any) => tx`select pg_advisory_xact_lock(hashtext(${1}), hashtext('openedbot-run-events-cursor'))`;",
      "export const next = (tx: any) => tx`select max(sequence) as last from run_events where run_id = ${1}`;",
      "export const write = (tx: any) => tx`insert into run_events (sequence) values (${1})`;",
    ].join("\n"),
    "modules/conversation/src/application/compact-room-request.ts":
      "export const m = (tx: any) => tx`select max(m.sequence) from messages m where m.thread_id = ${1}`;\n",
    "modules/execution/src/application/routines.ts": [
      "// insert into run_events is named here, in a comment only",
      "export const purge = (tx: any) => tx`delete from run_events e where e.created_at < ${1}`;",
    ].join("\n"),
    "db/migrations/0092_run_events_identity.sql": "update run_events event set bot_id = run.bot_id from runs run;\n",
  };
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  return root;
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function run(root: string): { code: number; output: string } {
  const result = Bun.spawnSync(["bun", SCRIPT, "--root", root], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("run-events-contract", () => {
  test("accepts the primitive, a max over another table and a retention purge", () => {
    const result = run(fixture());
    expect(result.output).toContain("seulement");
    expect(result.code).toBe(0);
  });

  test("refuses a write of run_events outside the primitive", () => {
    for (const statement of ["insert into run_events (sequence) values (0)", "UPDATE public.run_events set payload = '{}'"]) {
      const root = fixture();
      write(root, "apps/api/src/routes/new-route.ts", `export const e = (tx: any) => tx\`${statement}\`;\n`);
      const result = run(root);
      expect(result.code).toBe(1);
      expect(result.output).toContain("apps/api/src/routes/new-route.ts:1");
      expect(result.output).toContain("hors de la primitive d'allocation");
    }
  });

  test("refuses a max(sequence) on run_events outside the primitive, aliased or not", () => {
    for (const statement of [
      "select coalesce(max(sequence), -1) + 1 as next from run_events where run_id = 1",
      "select coalesce((select max(event.sequence) + 1 from run_events event), 0)",
    ]) {
      const root = fixture();
      write(root, "modules/execution/src/application/runner/failure.ts",
        `const x = 1;\nexport const f = (db: any) => db\`\n  ${statement}\n\`;\n`);
      const result = run(root);
      expect(result.code).toBe(1);
      expect(result.output).toContain("modules/execution/src/application/runner/failure.ts:3");
      expect(result.output).toContain("sur run_events hors de la primitive");
    }
  });

  test("refuses the cursor lock outside the primitive", () => {
    const root = fixture();
    write(root, "modules/execution/src/application/queue.ts",
      "export const l = (tx: any) => tx`select pg_advisory_xact_lock(hashtext(${1}), hashtext('openedbot-run-events-cursor'))`;\n");
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("verrou du curseur des événements pris hors de la primitive");
  });

  test("refuses a migration that writes run_events, and a missing primitive", () => {
    const root = fixture();
    write(root, "db/migrations/0176_trigger.sql", "create function f() returns trigger as $$ begin insert into run_events (sequence) values (0); end $$;\n");
    rmSync(join(root, "modules/execution/src/sql/run-events.ts"));
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("db/migrations/0176_trigger.sql:1");
    expect(result.output).toContain("est introuvable");
  });
});
