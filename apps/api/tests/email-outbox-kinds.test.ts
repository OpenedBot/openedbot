import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSACTIONAL_EMAIL_KINDS } from "@openedbot/contracts-api";

const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "db", "migrations");

/**
 * `email_outbox_kind_check` est la JUMELLE SQL de `TRANSACTIONAL_EMAIL_KINDS`,
 * et les deux se paient cher quand elles divergent :
 *
 * - un genre ajouté en TypeScript sans sa contrainte n'entre JAMAIS dans la
 *   file : l'insertion échoue au moment même du fait qui la justifie, et selon
 *   la transaction c'est tout le geste qui tombe ;
 * - un genre resté dans la contrainte sans son gabarit part en échec de rendu
 *   chez le worker, pour chaque destinataire, jusqu'à épuisement des reprises.
 *
 * Ce test lit la DERNIÈRE migration qui redéfinit la contrainte : c'est celle
 * qui fait foi sur une base à jour, les précédentes ayant été remplacées.
 */
function lastKindConstraint(): string[] {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  let latest: string | null = null;
  for (const name of files) {
    const sql = readFileSync(join(MIGRATIONS, name), "utf8");
    const match = /add constraint email_outbox_kind_check\s*check\s*\(kind in \(([^)]*)\)\)/i.exec(sql);
    if (match?.[1]) latest = match[1];
  }
  if (latest === null) throw new Error("aucune migration ne définit email_outbox_kind_check");
  return [...latest.matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1] as string);
}

describe("contrainte de genre d’email_outbox", () => {
  test("porte exactement les genres déclarés en TypeScript", () => {
    expect(lastKindConstraint().sort()).toEqual([...TRANSACTIONAL_EMAIL_KINDS].sort());
  });

  test("porte le genre du mot de passe reposé par l’équipe", () => {
    // Nommé à part : sans lui, `POST /users/:userId/temporary-password` poserait
    // le mot de passe puis échouerait au dépôt du message, dans la même
    // transaction, et le geste entier tomberait.
    expect(lastKindConstraint()).toContain("staff_password_reset");
  });
});
