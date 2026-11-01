import type { Db } from "@openedbot/platform-db";

/**
 * Les enrôlements de runtime sont des jetons à durée de vie courte : passé leur
 * expiration ou leur consommation, les garder ne fait qu'entretenir une table
 * de secrets hachés. On les supprime plutôt que de les archiver : l'audit vit
 * dans la ligne `runtimes` créée, pas dans le jeton qui l'a créée.
 *
 * Une ligne consommée est gardée une journée : le temps qu'un opérateur
 * comprenne un enrôlement qui vient de finir, pas davantage.
 */
export async function purgeStaleRuntimeEnrollments(db: Db, now: Date = new Date()): Promise<number> {
  const consumedCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const rows = await db<Array<{ count: string | number }>>`
    with deleted as (
      delete from runtime_enrollments
       where (consumed_at is null and expires_at < ${now})
          or (consumed_at is not null and consumed_at < ${consumedCutoff})
       returning id
    )
    select count(*) as count from deleted
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Le secret est effacé en même temps que l'enrôlement est consommé : la ligne
 * reste pour l'audit, mais plus rien ne la rouvre. `false` si l'enrôlement a
 * déjà été utilisé.
 */
export async function consumeRuntimeEnrollment(
  tx: Db,
  input: { enrollmentId: string; organizationId: string; runtimeId: string },
): Promise<boolean> {
  const burned = await tx<Array<{ id: string }>>`
    update runtime_enrollments
       set consumed_at = now(), runtime_id = ${input.runtimeId},
           secret_hash = ${`consumed:${crypto.randomUUID()}`}
     where id = ${input.enrollmentId} and organization_id = ${input.organizationId} and consumed_at is null
    returning id
  `;
  return burned.length === 1;
}
