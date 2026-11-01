import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Le fencing de `run_events` (0092) ne protège que l'écrivain qui DÉCLARE son
 * bail : sans `lease_generation` à l'INSERT, le trigger estampille la
 * génération courante et une ligne tardive d'un worker repris passerait.
 * La preuve PostgreSQL (`tests/integration/run-events-identity.sql`) montre
 * le refus ; ce test garde que le porteur de bail, `persistEvents`, le déclare.
 */
const runner = readFileSync(
  fileURLToPath(new URL("../../src/application/runner/persist.ts", import.meta.url)),
  "utf8",
);

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} introuvable`);
  const next = source.indexOf("\nasync function ", start + 1);
  const nextExport = source.indexOf("\nexport ", start + 1);
  const end = Math.min(...[next, nextExport].filter((index) => index > 0));
  return source.slice(start, end);
}

describe("persistEvents écrit sous son bail", () => {
  const body = functionBody(runner, "persistEvents");

  test("l'INSERT run_events déclare lease_generation avec la génération du contexte", () => {
    const insert = body.match(/insert into run_events \(([^)]*)\)\s*values \(([\s\S]*?)\)\s*on conflict/u);
    expect(insert).not.toBeNull();
    const columns = insert![1]!.split(",").map((column) => column.trim());
    expect(columns).toContain("lease_generation");
    expect(insert![2]).toContain("${context.leaseGeneration}");
  });

  test("l'enveloppe relit l'identité posée par le trigger au lieu de la recalculer", () => {
    expect(body).toMatch(/returning cursor, bot_id as "botId", turn_id as "turnId", session_key as "sessionKey",\s*lease_generation as "leaseGeneration"/u);
    expect(body).toContain("organizationEventEnvelope(");
  });
});
