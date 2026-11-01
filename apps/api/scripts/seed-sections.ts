import type { TransactionDb } from "@openedbot/platform-db";

/**
 * Pose la section « Bots » semée d'une organisation de développement, et
 * rend l'identifiant de la section où ranger les bots semés.
 *
 * Rejouable : `on conflict (id)` ne couvrait que la clé primaire, alors que
 * `sections` porte aussi `unique (organization_id, position)`. Dès qu'une autre
 * section occupait le rang 0 (section par défaut recréée par l'application,
 * sections réordonnées), un second `make db-seed` tombait sur
 * `sections_organization_id_position_key`. Ici, aucune contrainte ne peut
 * faire échouer le seed, et la disposition choisie dans l'application n'est
 * jamais réécrite :
 * 1. la section semée est créée au rang 0 si ni son identifiant ni ce rang ne
 *    sont pris ;
 * 2. sinon, si elle existe déjà, elle reprend son nom (comportement d'avant) ;
 * 3. sinon, les bots semés vont dans la section par défaut (la première).
 */
export async function seedDefaultSection(
  tx: TransactionDb,
  organizationId: string,
  sectionId: string,
): Promise<string> {
  const inserted = await tx<Array<{ id: string }>>`
    insert into sections (id, organization_id, name, position)
    values (${sectionId}, ${organizationId}, 'Bots', 0)
    on conflict do nothing
    returning id
  `;
  if (inserted[0]) return inserted[0].id;
  const existing = await tx<Array<{ id: string }>>`
    update sections set name = 'Bots', updated_at = now()
     where organization_id = ${organizationId} and id = ${sectionId}
    returning id
  `;
  if (existing[0]) return existing[0].id;
  const fallback = await tx<Array<{ id: string }>>`
    select id from sections where organization_id = ${organizationId} order by position asc limit 1
  `;
  if (!fallback[0]) throw new Error(`Seed: no section could be placed for organization ${organizationId}.`);
  return fallback[0].id;
}
