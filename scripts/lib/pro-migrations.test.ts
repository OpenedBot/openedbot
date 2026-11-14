import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, type ProPlugin } from "../../platform/plugins/src/index";
import { proMigrationPlan, proMigrationVersion } from "./pro-migrations";

function plugin(id: string, directory?: string): ProPlugin {
  return {
    manifest: { id, version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: [] },
    ...(directory ? { migrations: { directory } } : {}),
  };
}

test("a plug-in migration is recorded as <id>:<file>", () => {
  expect(proMigrationVersion("reports", "0001_grants.sql")).toBe("reports:0001_grants");
});

test("solo: no plug-in, no migration", () => {
  expect(proMigrationPlan([], () => { throw new Error("must not list"); })).toEqual([]);
});

test("files are sorted per plug-in, in load order; only NNNN_name.sql files count", () => {
  const root = mkdtempSync(join(tmpdir(), "pro-migrations-"));
  const billing = join(root, "billing");
  mkdirSync(billing);
  for (const file of ["0002_prices.sql", "0001_plans.sql", "README.md", "0003-Bad.sql", "0004_ok.sql.bak"]) {
    writeFileSync(join(billing, file), "select 1;\n");
  }
  const plan = proMigrationPlan([plugin("zeta", undefined), plugin("billing", billing), plugin("audit", undefined)]);
  expect(plan).toEqual([
    { version: "billing:0001_plans", path: join(billing, "0001_plans.sql") },
    { version: "billing:0002_prices", path: join(billing, "0002_prices.sql") },
  ]);
});

test("a declared migrations directory that does not exist is an error", () => {
  expect(() => proMigrationPlan([plugin("billing", "/nonexistent/pro-migrations")])).toThrow();
});
