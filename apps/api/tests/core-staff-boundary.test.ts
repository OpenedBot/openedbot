import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

function sources(dir: string): Array<[string, string]> {
  return readdirSync(join(root, dir))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => [`${dir}/${name}`, readFileSync(join(root, dir, name), "utf8")]);
}

/**
 * The back office's contracts and transaction helpers live in the pro staff
 * package: the core API contracts and the DB layer export none of them.
 */
describe("core keeps no back-office contract", () => {
  test("no Staff*/STAFF_* export in the API contracts, no withStaff* helper in the DB layer", () => {
    const offenders = [...sources("contracts/api/src"), ...sources("platform/db/src")].flatMap(([file, text]) =>
      [...text.matchAll(/^export (?:type|interface|const|function|async function) ((?:Staff|STAFF_|withStaff)\w*)/gm)]
        .map((match) => `${file}: ${match[1]}`));
    expect(offenders).toEqual([]);
  });
});
