import type { TransactionDb } from "@openedbot/platform-db";
import { moveTeamImportsToDefaultSection } from "@openedbot/portability/sql/team-imports";

/**
 * Une section qui n'a plus ni bot ni salon disparaît d'elle-même : elle
 * n'existe que par ce qu'elle range. La section par défaut (première par
 * rang, « Non assigné ») reste toujours ; un import d'équipe qui pointait
 * une section purgée est rattaché à la section par défaut, comme lors
 * d'une suppression explicite (`team_imports` appartient à `portability`).
 *
 * À appeler dans la transaction de tout ce qui peut vider une section :
 * changement de section d'un bot ou d'un salon, réordonnancement,
 * suppression d'un bot ou d'un salon.
 */
export async function pruneEmptySections(tx: TransactionDb, organizationId: string): Promise<string[]> {
  const empty = await tx<Array<{ id: string }>>`
    select s.id from sections s
     where s.organization_id = ${organizationId}
       and s.id <> (select id from sections where organization_id = ${organizationId} order by position asc limit 1)
       and not exists (select 1 from bots b where b.organization_id = s.organization_id and b.section_id = s.id)
       and not exists (select 1 from bot_groups g where g.organization_id = s.organization_id and g.section_id = s.id)
  `;
  if (empty.length === 0) return [];
  const ids = empty.map((row) => row.id);
  await moveTeamImportsToDefaultSection(tx, organizationId, ids);
  await tx`
    delete from sections where organization_id = ${organizationId} and id in ${tx(ids)}
  `;
  return ids;
}
