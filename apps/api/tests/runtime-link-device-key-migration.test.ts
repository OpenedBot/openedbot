import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../../../db/migrations/0054_runtime_link_device_key_registered.sql", import.meta.url), "utf8");
const previousKinds = [
  "connected",
  "replaced",
  "disconnected",
  "revoked",
  "rotated",
  "hijack_suspected",
  "pop_failed",
  "pop_missing",
  "unattributed_session",
  "clock_skew",
  "worm_write_failed",
  "anchor_tampered",
];

/** Contrat de la migration 0054 : elle étend uniquement la contrainte du journal du lien. */
describe("contrat de la migration 0054_runtime_link_device_key_registered", () => {
  test("transactionnelle, enregistrée et sans suppression de table", () => {
    expect(migration.trimStart().startsWith("begin;")).toBe(true);
    expect(migration.trimEnd().endsWith("commit;")).toBe(true);
    expect(migration).toContain("insert into schema_migrations(version) values ('0054_runtime_link_device_key_registered')");
    expect(migration).not.toMatch(/drop table/i);
  });

  test("conserve tous les kinds de 0053 et ajoute device_key_registered", () => {
    for (const kind of [...previousKinds, "device_key_registered"]) {
      expect(migration).toContain(`'${kind}'`);
    }
    expect(migration).toContain("alter table runtime_link_events drop constraint runtime_link_events_kind_check;");
    expect(migration).toContain("alter table runtime_link_events add constraint runtime_link_events_kind_check");
  });

  test("documente la première clé inscrite après preuve de possession", () => {
    expect(migration).toContain(
      "device_key_registered : première clé device inscrite après preuve de possession sous le jeton courant (runtime enrôlé avant le PoP)",
    );
  });
});
