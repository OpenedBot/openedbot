import type { SQL } from "bun";

/**
 * Purge du journal des erreurs non prévues de l'API (`api_errors`, 0161).
 *
 * La rétention de 90 jours n'est pas un réglage du worker : elle est écrite
 * dans les policies `api_errors_worker_*`, qui ne laissent voir et supprimer à
 * openedbot_worker que les lignes plus vieilles. Le filtre ci-dessous dit la même
 * chose pour que la requête se lise seule ; s'ils divergeaient, la policy
 * gagnerait. Une référence citée au support est relue bien avant trois mois.
 */
export async function purgeOldApiErrors(db: SQL): Promise<number> {
  const rows = await db<Array<{ count: string | number }>>`
    with deleted as (
      delete from api_errors where occurred_at < now() - interval '90 days' returning reference
    )
    select count(*) as count from deleted
  `;
  return Number(rows[0]?.count ?? 0);
}
