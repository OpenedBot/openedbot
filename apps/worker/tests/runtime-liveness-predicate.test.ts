import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Test statique (motif de `apps/api/tests/run-events-cursor-lock.test.ts`) :
 * la réclamation (`queue.ts`) et la relecture de contexte (`runner/context.ts`)
 * doivent porter LE MÊME prédicat de vitalité du lien connecteur. S'ils
 * divergent, un run réclamé sur un lien vivant peut se relire sur un lien
 * mort (ou l'inverse), et la fenêtre de 45 s ne veut plus rien dire.
 *
 * La fenêtre est aussi celle du balayage `disconnected`
 * (`modules/runtime-link/src/application/runtime-links.ts`) : le même texte
 * d'intervalle y est exigé.
 */
const PREDICATE = "rt.reachability = 'connector'";
const STALE_INTERVAL = "interval '45 seconds'";
const REPO_ROOT = new URL("../../../", import.meta.url);

function source(relativeFromRepo: string): string {
  return readFileSync(fileURLToPath(new URL(relativeFromRepo, REPO_ROOT)), "utf8");
}

describe("prédicat de vitalité du lien connecteur", () => {
  test("queue.ts et runner/context.ts portent exactement le même prédicat", () => {
    expect(source("modules/execution/src/application/queue.ts")).toContain(PREDICATE);
    expect(source("modules/execution/src/application/runner/context.ts")).toContain(PREDICATE);
    expect(source("modules/execution/src/application/queue.ts")).toContain("rt.reachability = 'direct'");
    expect(source("modules/execution/src/application/runner/context.ts")).toContain("rt.reachability = 'direct'");
    for (const file of ["modules/execution/src/application/runner/context.ts", "modules/execution/src/application/queue.ts"]) {
      expect(source(file)).toContain("rt.last_health_status = 'healthy'");
      expect(source(file)).toContain("rt.last_probed_at > now() - interval '90 seconds'");
    }
  });

  test("le balayage disconnected juge sur la même fenêtre de 45 secondes", () => {
    expect(source("modules/runtime-link/src/application/runtime-links.ts")).toContain(STALE_INTERVAL);
  });

  test("un runtime dont l'instance est vivante n'est pas marqué disconnected par le seul fait d'être ailleurs", () => {
    const maintenance = source("modules/runtime-link/src/application/runtime-links.ts");
    expect(maintenance).toContain("from api_instances inst");
    expect(maintenance).toContain("interval '60 seconds'");
    expect(maintenance).toContain("inst.stopped_at is null");
    expect(maintenance).toContain("and not (");
    expect(maintenance).toContain("failRunsOnDisconnectedRuntimes");
  });
});
