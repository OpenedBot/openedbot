import { describe, expect, test } from "bun:test";
import { isUndefinedTable, isUniqueViolation, uniqueViolationNames } from "../src/db";

describe("le conflit d'unicité", () => {
  test("Bun le nomme dans errno, pas dans code : les deux comptent", () => {
    const bun = Object.assign(new Error("duplicate key"), {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "23505",
    });
    expect(isUniqueViolation(bun)).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error("dup"), { code: "23505" }))).toBe(true);
  });

  test("une autre erreur SQL n'est pas une collision", () => {
    const denied = Object.assign(new Error("permission denied"), {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "42501",
    });
    expect(isUniqueViolation(denied)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });

  test("extrait les noms du détail Postgres, sinon le repli", () => {
    const bun = Object.assign(new Error("duplicate key"), {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "23505",
      detail: "Key (organization_id, slug)=(aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee, atlas-seo-geo) already exists.",
    });
    expect(uniqueViolationNames(bun, ["Atlas"])).toEqual(["atlas-seo-geo"]);
    expect(uniqueViolationNames(new Error("dup"), ["Scout", "Editor"])).toEqual(["Scout", "Editor"]);
  });
});

describe("une table absente", () => {
  test("Bun range 42P01 dans errno", () => {
    const bun = Object.assign(new Error('relation "staff_users" does not exist'), {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "42P01",
    });
    expect(isUndefinedTable(bun)).toBe(true);
    expect(isUndefinedTable(Object.assign(new Error("missing"), { code: "42P01" }))).toBe(true);
    expect(isUndefinedTable(Object.assign(new Error("dup"), { errno: "23505" }))).toBe(false);
  });
});
