import { describe, expect, test } from "bun:test";
import type { Db } from "@openedbot/platform-db";
import { createLinkLivenessStore, type LinkIdentity } from "../src/application/broker";

/**
 * Rotation incertaine (0174) : l'admission de l'hôte tranche. Le jeton
 * courant confirme, l'ancien défait une rotation non confirmée. Base factice :
 * chaque requête est journalisée, l'issue de chaque UPDATE est choisie par le test.
 */
type Statement = { sql: string; values: unknown[] };

function fakeDb(outcome: "confirmed" | "reverted" | null): { db: Db; statements: Statement[] } {
  const statements: Statement[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join("?");
    statements.push({ sql, values });
    if (sql.includes("set link_instance_id")) return Promise.resolve([{ id: "rt" }]);
    if (sql.includes("link_token_hash = ? and link_token_previous_hash is not null")) {
      return Promise.resolve(outcome === "confirmed" ? [{ id: "rt" }] : []);
    }
    if (sql.includes("link_token_rotation_unconfirmed_at is not null")) {
      return Promise.resolve(outcome === "reverted" ? [{ id: "rt" }] : []);
    }
    return Promise.resolve([]);
  }) as unknown as Db;
  const db = Object.assign(tx, { begin: (callback: (tx: Db) => Promise<unknown>) => callback(tx) }) as unknown as Db;
  return { db, statements };
}

const link: LinkIdentity = {
  runtimeId: "8f3b2c1d-1111-4222-8333-444455556666",
  organizationId: "0b9c6a1e-0000-4000-8000-000000000001",
  tokenHash: "presented-hash",
  expiresAt: null,
  generation: "7",
};

describe("admission : le jeton présenté tranche la rotation en cours", () => {
  test("le jeton courant confirme : l'ancien hash part, sans défaire ni journaliser", async () => {
    const { db, statements } = fakeDb("confirmed");
    await createLinkLivenessStore(db).connected(link, "instance-a", []);
    const confirm = statements.find((entry) => entry.sql.includes("link_token_hash = ? and link_token_previous_hash is not null"))!;
    expect(confirm.sql).toContain("set link_token_previous_hash = null");
    expect(confirm.values).toContain("presented-hash");
    expect(statements.some((entry) => entry.sql.includes("link_token_rotation_unconfirmed_at is not null"))).toBe(false);
    expect(statements.some((entry) => entry.sql.includes("insert into runtime_link_events"))).toBe(false);
  });

  test("l'ancien jeton pendant une rotation non confirmée la défait, et le journal le dit", async () => {
    const { db, statements } = fakeDb("reverted");
    await createLinkLivenessStore(db).connected(link, "instance-a", []);
    const revert = statements.find((entry) => entry.sql.includes("link_token_rotation_unconfirmed_at is not null"))!;
    // Seule une rotation marquée non confirmée, avec l'ancien hash encore en grâce, se défait.
    expect(revert.sql).toContain("set link_token_hash = ?");
    expect(revert.sql).toContain("link_token_previous_hash = ? and link_token_previous_expires_at > now()");
    const event = statements.find((entry) => entry.sql.includes("insert into runtime_link_events"))!;
    expect(event.values[2]).toBe("rotated");
    expect(event.values[6]).toEqual({ automatic: true, reason: "unconfirmed_reverted" });
  });

  test("hors rotation, l'admission ne touche à aucun jeton", async () => {
    const { db, statements } = fakeDb(null);
    await createLinkLivenessStore(db).connected(link, "instance-a", []);
    expect(statements.some((entry) => entry.sql.includes("insert into runtime_link_events"))).toBe(false);
  });
});
