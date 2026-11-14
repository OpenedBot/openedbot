import { describe, expect, test } from "bun:test";
import type { TransactionDb } from "@openedbot/platform-db";
import { seedDefaultSection } from "../scripts/seed-sections";

const organizationId = "00000000-0000-4000-8000-000000000201";
const sectionId = "00000000-0000-4000-8000-000000000301";

type Section = { id: string; organizationId: string; name: string; position: number };

/**
 * An in-memory `sections` table that applies the two real constraints:
 * the primary key and `unique (organization_id, position)`. An `insert` without
 * `on conflict do nothing` that violates them raises the Postgres error.
 */
function sectionsTable(initial: Section[]) {
  const rows = [...initial];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    if (sql.startsWith("insert into sections")) {
      const [id, org] = values as [string, string];
      const clash = rows.find((row) => row.id === id)
        ? "sections_pkey"
        : rows.find((row) => row.organizationId === org && row.position === 0)
          ? "sections_organization_id_position_key"
          : null;
      if (clash) {
        if (sql.includes("on conflict do nothing")) return Promise.resolve([]);
        return Promise.reject(new Error(`duplicate key value violates unique constraint "${clash}"`));
      }
      rows.push({ id, organizationId: org, name: "Bots", position: 0 });
      return Promise.resolve([{ id }]);
    }
    if (sql.startsWith("update sections")) {
      const [org, id] = values as [string, string];
      const row = rows.find((candidate) => candidate.organizationId === org && candidate.id === id);
      if (row) row.name = "Bots";
      return Promise.resolve(row ? [{ id: row.id }] : []);
    }
    if (sql.startsWith("select id from sections")) {
      const [org] = values as [string];
      const first = rows.filter((row) => row.organizationId === org).sort((a, b) => a.position - b.position)[0];
      return Promise.resolve(first ? [{ id: first.id }] : []);
    }
    return Promise.reject(new Error(`unexpected query: ${sql}`));
  }) as unknown as TransactionDb;
  return { tx, rows };
}

describe("dev seed default section", () => {
  test("a fresh organization gets the seeded section at rank 0", async () => {
    const { tx, rows } = sectionsTable([]);
    expect(await seedDefaultSection(tx, organizationId, sectionId)).toBe(sectionId);
    expect(rows).toEqual([{ id: sectionId, organizationId, name: "Bots", position: 0 }]);
  });

  test("re-running the seed is a no-op that restores the seeded name", async () => {
    const { tx, rows } = sectionsTable([{ id: sectionId, organizationId, name: "Renamed", position: 0 }]);
    expect(await seedDefaultSection(tx, organizationId, sectionId)).toBe(sectionId);
    expect(await seedDefaultSection(tx, organizationId, sectionId)).toBe(sectionId);
    expect(rows).toEqual([{ id: sectionId, organizationId, name: "Bots", position: 0 }]);
  });

  test("another section on rank 0 no longer crashes the seed (sections_organization_id_position_key)", async () => {
    const other = "00000000-0000-4000-8000-0000000009aa";
    const { tx, rows } = sectionsTable([{ id: other, organizationId, name: "Mine", position: 0 }]);
    expect(await seedDefaultSection(tx, organizationId, sectionId)).toBe(other);
    expect(rows).toEqual([{ id: other, organizationId, name: "Mine", position: 0 }]);
  });

  test("a seeded section moved off rank 0 keeps its place", async () => {
    const other = "00000000-0000-4000-8000-0000000009aa";
    const { tx, rows } = sectionsTable([
      { id: other, organizationId, name: "Mine", position: 0 },
      { id: sectionId, organizationId, name: "Bots", position: 1 },
    ]);
    expect(await seedDefaultSection(tx, organizationId, sectionId)).toBe(sectionId);
    expect(rows.map((row) => [row.id, row.position])).toEqual([[other, 0], [sectionId, 1]]);
  });
});
