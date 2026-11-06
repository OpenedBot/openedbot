import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "foreign-reads-contract.ts");
const roots: string[] = [];

/** Two modules, one app: the roster reads its bots and one frozen thread; the API reads one frozen bot. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "foreign-reads-contract-"));
  roots.push(root);
  const files: Record<string, string> = {
    "db/ownership.json": JSON.stringify({
      $migrations: {},
      bots: "roster",
      threads: { owner: "conversation", writers: ["roster"] },
      api_errors: { owner: "apps/api", writers: ["apps/worker"] },
    }),
    "modules/roster/src/sql/bots.ts": [
      "// select * from threads, in a comment only",
      "export const a = (tx: any) => tx`select id from bots b join threads t on t.bot_id = b.id`;",
      "export const b = (tx: any) => tx`delete from threads where id = ${1}`;",
      'import { x } from "threads";',
    ].join("\n"),
    "modules/roster/tests/bots.test.ts": "export const t = (tx: any) => tx`select * from threads`;\n",
    "apps/api/src/routes.ts": "export const r = (tx: any) => tx`select id from bots where id = ${1}; select * from api_errors`;\n",
    "tests/scripts/foreign-reads-debt.json": JSON.stringify({
      until: "2999-12-31", reason: "fixture",
      files: { "apps/api/src/routes.ts": { bots: 1 }, "modules/roster/src/sql/bots.ts": { threads: 1 } },
    }),
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

describe("foreign-reads-contract", () => {
  test("counts reads of another context's tables only: own tables, comments, deletes, imports and tests are not reads", () => {
    const result = run(fixture());
    expect(result.output).toContain("2 lectures de tables étrangères dans 2 fichiers");
    expect(result.code).toBe(0);
  });

  test("refuses a new foreign read in a listed file, and in a file the debt does not list", () => {
    const root = fixture();
    write(root, "modules/roster/src/sql/bots.ts", "export const a = (tx: any) => tx`select 1 from threads; select 2 from threads`;\n");
    write(root, "modules/roster/src/application/groups.ts", "export const g = (tx: any) => tx`select 1 from public.threads`;\n");
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("modules/roster/src/sql/bots.ts:1 : 2 lecture(s) de threads (propriétaire : conversation) pour un plafond de 1");
    expect(result.output).toContain("modules/roster/src/application/groups.ts:1 : 1 lecture(s) de threads (propriétaire : conversation) pour un plafond de 0");
  });

  test("a declared writer is not a reader: an application reading a table it may write still counts", () => {
    const root = fixture();
    write(root, "apps/worker/src/purge.ts", "export const p = (tx: any) => tx`select count(*) from api_errors`;\n");
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("apps/worker/src/purge.ts:1 : 1 lecture(s) de api_errors (propriétaire : apps/api)");
  });

  test("a read that went away must be recorded, and --record lowers the ceiling", () => {
    const root = fixture();
    write(root, "apps/api/src/routes.ts", "export const r = (tx: any) => tx`select * from api_errors`;\n");
    expect(run(root).output).toContain("apps/api/src/routes.ts : 0 lecture(s) de bots pour un plafond de 1 ; constatez le gain avec --record");
    expect(run(root, "--record").code).toBe(0);
    const debt = JSON.parse(readFileSync(join(root, "tests/scripts/foreign-reads-debt.json"), "utf8"));
    expect(debt.files).toEqual({ "modules/roster/src/sql/bots.ts": { threads: 1 } });
    expect(run(root).code).toBe(0);
  });

  test("a debt past its date warns without failing", () => {
    const root = fixture();
    const debt = JSON.parse(readFileSync(join(root, "tests/scripts/foreign-reads-debt.json"), "utf8"));
    write(root, "tests/scripts/foreign-reads-debt.json", JSON.stringify({ ...debt, until: "2000-01-01" }));
    const result = run(root);
    expect(result.code).toBe(0);
    expect(result.output).toContain("cliquet échu depuis le 2000-01-01");
  });
});
