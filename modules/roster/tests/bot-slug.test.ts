import { describe, expect, test } from "bun:test";
import type { Db } from "@openedbot/platform-db";
import { chooseBotSlug, suffixedSlug } from "../src/application/bot-slug";

/** Une base qui répond aux deux lectures de `chooseBotSlug` : slugs pris, réservations d'import. */
function fakeDb(taken: readonly string[], reserved: readonly string[] = []): Db {
  const db = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?");
    if (sql.includes("from bots")) {
      const candidates = values.find(Array.isArray) as string[];
      return Promise.resolve(candidates.filter((name) => taken.includes(name)).map((name) => ({ name })));
    }
    if (sql.includes("profile_import_items")) {
      const names = JSON.parse(String(values[1])) as string[];
      return Promise.resolve(names.filter((name) => reserved.includes(name)).map((slug) => ({ slug })));
    }
    return Promise.resolve([]);
  }) as unknown as Db;
  Object.assign(db, {
    array: (values: unknown[]) => values,
    begin: async (callback: (tx: Db) => unknown) => callback(db),
  });
  return db;
}

describe("chooseBotSlug", () => {
  test("recréer un bot du même nom qu'un bot à la corbeille prend le slug suivant", async () => {
    expect(await chooseBotSlug(fakeDb(["nouveau-bot"]), "org-1", { slug: "nouveau-bot", slugFromName: true })).toBe("nouveau-bot-2");
    expect(await chooseBotSlug(fakeDb(["nouveau-bot", "nouveau-bot-2"]), "org-1", { slug: "nouveau-bot", slugFromName: true })).toBe("nouveau-bot-3");
  });

  test("un nom libre garde son slug", async () => {
    expect(await chooseBotSlug(fakeDb([]), "org-1", { slug: "scout", slugFromName: true })).toBe("scout");
  });

  test("un slug explicite n'est jamais changé : sa collision reste un 409 à l'insert", async () => {
    expect(await chooseBotSlug(fakeDb(["scout"]), "org-1", { slug: "scout", slugFromName: false })).toBe("scout");
    expect(await chooseBotSlug(fakeDb(["scout"]), "org-1", { slug: "scout" })).toBe("scout");
  });

  test("un nom réservé par un import de profils reste refusé", async () => {
    await expect(chooseBotSlug(fakeDb([], ["scout"]), "org-1", { slug: "scout", slugFromName: true }))
      .rejects.toMatchObject({ status: 409 });
  });
});

describe("suffixedSlug", () => {
  test("tient dans un nom de profil Hermes (63 caractères)", () => {
    const long = "a".repeat(62) + "b";
    expect(suffixedSlug(long, 2)).toHaveLength(63);
    expect(suffixedSlug(long, 2).endsWith("-2")).toBe(true);
    expect(suffixedSlug("x".repeat(60) + "-yy", 12)).toBe("x".repeat(60) + "-12");
  });
});
