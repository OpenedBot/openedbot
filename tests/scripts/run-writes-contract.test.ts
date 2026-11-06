import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "run-writes-contract.ts");
const roots: string[] = [];

/** A minimal tree the contract accepts: primitives, one command, one counted transition, the review trigger. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "run-writes-contract-"));
  roots.push(root);
  const files: Record<string, string> = {
    "modules/execution/src/sql/run-writes.ts": [
      "/** The only writer: insert into runs, insert into workflows. */",
      "export const a = (tx: any) => tx`insert into runs (id) values (${1})`;",
      "export const b = (tx: any) => tx`insert into workflows (id) values (${1})`;",
      "export const c = (tx: any) => tx`update workflows set used_steps = used_steps + 1 where id = ${1}`;",
    ].join("\n"),
    "modules/execution/src/application/run-creation.ts": 'import { a } from "../sql/run-writes";\nexport { a };\n',
    "modules/execution/src/application/queue.ts": [
      "// insert into runs is named here, in a comment only",
      "export const d = (tx: any) => tx`update runs set status = 'failed' where id = ${1}`;",
    ].join("\n"),
    "tests/scripts/run-writes-debt.json": JSON.stringify({
      until: "2999-12-31", step: "S2d", reason: "fixture",
      files: { "modules/execution/src/application/queue.ts": { runs: 1 } },
    }),
    "db/migrations/0091_run_admission_envelope.sql": "insert into public.workflows (id) values (gen_random_uuid());\n",
  };
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  return root;
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function run(root: string, ...flags: string[]): { code: number; output: string } {
  const result = Bun.spawnSync(["bun", SCRIPT, "--root", root, ...flags], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("run-writes-contract", () => {
  test("accepts creations in the primitives and the counted transitions", () => {
    const result = run(fixture());
    expect(result.output).toContain("1 transitions sous le cliquet S2d");
    expect(result.code).toBe(0);
  });

  test("refuses an insert into runs or workflows outside the primitives", () => {
    for (const statement of ["insert into runs (id) values (1)", "INSERT INTO public.workflows (id) values (1)", "delete from runs where id = 1"]) {
      const root = fixture();
      write(root, "apps/api/src/routes/new-route.ts", `export const e = (tx: any) => tx\`${statement}\`;\n`);
      const result = run(root);
      expect(result.code).toBe(1);
      expect(result.output).toContain("apps/api/src/routes/new-route.ts:1");
      expect(result.output).toContain("hors des primitives de création");
    }
  });

  test("refuses a workflow step claim outside claimWorkflowStepTx", () => {
    const root = fixture();
    write(root, "modules/execution/src/application/runner/rooms.ts",
      "export const f = (tx: any) => tx`update workflows set status = 'running', used_handoffs = used_handoffs + 1`;\n");
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("compte d'étapes d'un workflow");
  });

  test("refuses an import of the primitives outside the commands", () => {
    const root = fixture();
    write(root, "modules/roster/src/application/bots.ts", 'import { a } from "@openedbot/execution/sql/run-writes";\nexport { a };\n');
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("importe les primitives privées");
  });

  test("refuses a new transition and an insert from another migration", () => {
    const root = fixture();
    write(root, "modules/execution/src/application/queue.ts",
      "export const d = (tx: any) => tx`update runs set status = 'failed'`;\nexport const g = (tx: any) => tx`update runs set status = 'queued'`;\n");
    write(root, "db/migrations/0176_backfill.sql", "insert into runs (id) select id from x;\n");
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("2 « update runs » pour un plafond de 1");
    expect(result.output).toContain("db/migrations/0176_backfill.sql:1");
  });

  test("a transition that disappears must be recorded, and --record only lowers", () => {
    const root = fixture();
    write(root, "modules/execution/src/application/queue.ts", "export const d = 1;\n");
    expect(run(root).output).toContain("constatez-le avec --record");
    expect(run(root, "--record").code).toBe(0);
    const debt = JSON.parse(readFileSync(join(root, "tests/scripts/run-writes-debt.json"), "utf8"));
    expect(debt.files).toEqual({});
    expect(debt.until).toBe("2999-12-31");
  });
});
