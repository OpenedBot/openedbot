import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Le fencing de `run_events` (0092) ne protège que l'écrivain qui DÉCLARE son
 * bail : sans `lease_generation` à l'INSERT, le trigger estampille la
 * génération courante et une ligne tardive d'un worker repris passerait.
 * La preuve PostgreSQL (`tests/integration/run-events-identity.sql`) montre
 * le refus ; ce test garde que le porteur de bail, `persistEvents`, le déclare
 * à la primitive d'allocation (S2c), et que la primitive l'écrit.
 */
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const persist = read("../../src/application/runner/persist.ts");
const primitive = read("../../src/sql/run-events.ts");

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} introuvable`);
  const next = source.indexOf("\nasync function ", start + 1);
  const nextExport = source.indexOf("\nexport ", start + 1);
  const end = Math.min(...[next, nextExport, source.length].filter((index) => index > 0));
  return source.slice(start, end);
}

describe("persistEvents écrit sous son bail", () => {
  const body = functionBody(persist, "persistBatch");

  test("les deux modes (numéroté, alloué) passent la génération du contexte à la primitive", () => {
    expect(body).toMatch(/const target = \{[^}]*leaseGeneration: context\.leaseGeneration[^}]*\}/u);
    expect(body).toMatch(/appendNumberedRunEventsTx\(tx, target,/u);
    expect(body).toMatch(/appendRunEventsTx\(tx, prepared\.map\(\(\{ event, payload \}\) => \(\{\s*\.\.\.target,/u);
  });

  test("l'INSERT de la primitive déclare lease_generation et relit l'identité posée par le trigger", () => {
    const insert = functionBody(primitive, "insertTx");
    const statement = insert.match(/insert into run_events \(([^)]*)\)\s*values \(([\s\S]*?)\)\s*returning/u);
    expect(statement).not.toBeNull();
    const columns = statement![1]!.split(",").map((column) => column.trim());
    expect(columns).toContain("lease_generation");
    expect(statement![2]).toContain("${event.leaseGeneration}");
    expect(insert).toMatch(/returning cursor, bot_id as "botId", turn_id as "turnId", session_key as "sessionKey",\s*lease_generation as "leaseGeneration"/u);
    expect(insert).toContain("organizationEventEnvelope(");
  });
});
