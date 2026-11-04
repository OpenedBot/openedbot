import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { executeProfileDelete } from "../src/application/delete-executor";
import type { DeleteJobRow } from "../src/sql/delete-jobs";

const ORG = "10000000-0000-4000-8000-000000000001";

function job(): DeleteJobRow {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    organization_id: ORG,
    created_by_user_id: null,
    runtime_id: "runtime-1",
    slugs: ["scout"],
    status: "running",
    total_profiles: 1,
    completed_profiles: 0,
    current_slug: null,
    results: [],
    error: null,
    lease_owner: "worker-1",
    lease_generation: 1,
    lease_expires_at: new Date(Date.now() + 60_000),
    created_at: new Date(),
    updated_at: new Date(),
  };
}

/** Une base dont le bail du job se perd au moment voulu ; un bot lié porte le profil. */
function leaseDb(lease: { held: boolean }, log: string[]): SQL {
  const db = ((strings: TemplateStringsArray) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    log.push(sql);
    if (sql.startsWith("select * from profile_delete_jobs")) return Promise.resolve(lease.held ? [job()] : []);
    if (sql.startsWith("select id from bots")) return Promise.resolve([{ id: "bot-1" }]);
    if (sql.startsWith("with before as")) return Promise.resolve([{ alreadyDeleting: false, wasArchived: false }]);
    if (sql.includes("hermes_session_id")) return Promise.resolve([{ sessionId: "ohb:o:thread-1", threadId: "thread-1", sessionGeneration: 0 }]);
    return Promise.resolve([]);
  }) as unknown as SQL;
  (db as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(db);
  return db;
}

describe("exécution d'un job de suppression de profils", () => {
  test("un bail perdu pendant l'inventaire n'autorise plus aucune mutation", async () => {
    const lease = { held: true };
    const log: string[] = [];
    const remote: string[] = [];
    await executeProfileDelete(leaseDb(lease, log), job(), {
      client: () => ({
        hostProfileInventory: async () => {
          lease.held = false;
          return { profiles: [{ name: "scout" }] } as never;
        },
        hostDeleteProfile: async (slug: string) => { remote.push(`profile:${slug}`); },
        deleteSession: async (id: string) => { remote.push(`session:${id}`); },
      }) as never,
    });
    expect(remote).toEqual([]);
    expect(log.some((sql) => sql.includes("host_profile_deleting_at"))).toBe(false);
    expect(log.some((sql) => sql.startsWith("delete from bots"))).toBe(false);
  });

  test("un bail perdu pendant la purge des sessions arrête avant le profil, sans rendre le bot", async () => {
    const lease = { held: true };
    const log: string[] = [];
    const remote: string[] = [];
    await executeProfileDelete(leaseDb(lease, log), job(), {
      client: () => ({
        hostProfileInventory: async () => ({ profiles: [{ name: "scout" }] }) as never,
        hostDeleteProfile: async (slug: string) => { remote.push(`profile:${slug}`); },
        deleteSession: async (id: string) => { remote.push(`session:${id}`); lease.held = false; },
      }) as never,
    });
    expect(remote).toEqual(["session:ohb:o:thread-1"]);
    // Un autre worker peut reprendre à partir de l'état posé : il reste.
    expect(log.some((sql) => sql.includes("set host_profile_deleting_at = null"))).toBe(false);
  });
});
