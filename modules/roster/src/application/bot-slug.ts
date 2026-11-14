import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { assertProfileNamesAvailable } from "./profile-import-guard";
import type { CreateBotInput } from "../domain/bot-input";

/** Au-delà, la collision redevient un 409 BOT_PROFILE_TAKEN. */
const SLUG_CANDIDATES = 50;
const MAX_SLUG_LENGTH = 63;

/** `nouveau-bot` → `nouveau-bot-2`, raccourci pour tenir dans un nom de profil Hermes. */
export function suffixedSlug(base: string, n: number): string {
  const suffix = `-${n}`;
  return `${base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
}

/**
 * Le slug d'un nouveau bot. Tiré de son nom, il prend le premier libre de
 * l'organisation : `nouveau-bot`, puis `nouveau-bot-2`… Un bot à la corbeille
 * garde le sien (il peut être restauré) : recréer « Nouveau bot » juste après
 * l'avoir supprimé tombait sur BOT_PROFILE_TAKEN. Un slug demandé
 * explicitement reste tel quel, et sa collision un 409.
 *
 * À appeler sous `withProfileNamesLock` : le verrou est celui de toute
 * l'organisation, aucune autre création ne prend le slug entre-temps.
 */
export async function chooseBotSlug(
  db: Db,
  organizationId: string,
  input: Pick<CreateBotInput, "slug" | "slugFromName">,
): Promise<string> {
  if (!input.slugFromName) return input.slug;
  const candidates = [input.slug, ...Array.from({ length: SLUG_CANDIDATES - 1 }, (_, index) => suffixedSlug(input.slug, index + 2))];
  const chosen = await withTenant(db, organizationId, async (tx) => {
    // Le slug devient le nom du profil géré : les deux colonnes sont uniques.
    const rows = await tx<Array<{ name: string }>>`
      select slug as name from bots
       where organization_id = ${organizationId} and slug = any(${tx.array(candidates, "TEXT")}::text[])
      union
      select hermes_profile as name from bots
       where organization_id = ${organizationId} and hermes_profile = any(${tx.array(candidates, "TEXT")}::text[])
    `;
    const taken = new Set(rows.map((row) => row.name));
    const slug = candidates.find((candidate) => !taken.has(candidate)) ?? input.slug;
    // Un import de profils peut réserver ce nom : même refus qu'avant.
    try {
      await assertProfileNamesAvailable(tx, organizationId, [slug]);
    } catch (error) {
      if (error instanceof HttpError) return { error };
      throw error;
    }
    return { slug };
  });
  if ("error" in chosen) throw chosen.error;
  return chosen.slug;
}
