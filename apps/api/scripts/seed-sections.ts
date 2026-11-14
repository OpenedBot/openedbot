import type { TransactionDb } from "@openedbot/platform-db";

/**
 * Plants the seeded « Bots » section of a development organization, and
 * returns the identifier of the section where the seeded bots go.
 *
 * Re-runnable: `on conflict (id)` covered only the primary key, whereas
 * `sections` also carries `unique (organization_id, position)`. As soon as another
 * section occupied rank 0 (default section recreated by the application,
 * sections reordered), a second `make db-seed` hit
 * `sections_organization_id_position_key`. Here, no constraint can
 * fail the seed, and the layout chosen in the application is
 * never rewritten:
 * 1. the seeded section is created at rank 0 if neither its identifier nor that rank
 *    is taken;
 * 2. otherwise, if it already exists, it takes its name back (the previous behavior);
 * 3. otherwise, the seeded bots go in the default section (the first one).
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
