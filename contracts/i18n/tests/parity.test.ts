import { describe, expect, test } from "bun:test";
import { en } from "../src/messages.en";
import { fr } from "../src/messages.fr";

/** Un arbre de messages : chaîne en feuille, espace de noms en nœud (même forme que `MessageTree` dans `index.ts`). */
type MessageTree = { readonly [key: string]: string | MessageTree };

/** Chemins pointés de toutes les feuilles string d'un arbre de messages, triés. */
function leafPaths(tree: MessageTree, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      paths.push(path);
    } else {
      paths.push(...leafPaths(value, path));
    }
  }
  return paths.sort();
}

describe("i18n message parity (fr/en)", () => {
  test("fr and en expose the exact same set of leaf keys", () => {
    const frPaths = new Set(leafPaths(fr as unknown as MessageTree));
    const enPaths = new Set(leafPaths(en as unknown as MessageTree));

    const missingInEn = [...frPaths].filter((path) => !enPaths.has(path)).sort();
    const missingInFr = [...enPaths].filter((path) => !frPaths.has(path)).sort();

    if (missingInEn.length > 0 || missingInFr.length > 0) {
      const details = [
        missingInEn.length > 0 ? `Missing in en:\n${missingInEn.join("\n")}` : null,
        missingInFr.length > 0 ? `Missing in fr:\n${missingInFr.join("\n")}` : null,
      ]
        .filter(Boolean)
        .join("\n\n");
      throw new Error(`fr/en key sets diverge.\n\n${details}`);
    }

    expect(missingInEn).toEqual([]);
    expect(missingInFr).toEqual([]);
  });

  test("the core dictionaries carry no back-office namespace (they live with the admin)", () => {
    for (const tree of [fr, en]) {
      expect(Object.keys(tree).filter((key) => /^staff[A-Z]/.test(key))).toEqual([]);
    }
  });
});
