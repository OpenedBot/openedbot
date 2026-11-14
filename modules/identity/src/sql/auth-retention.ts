import type { SQL } from "bun";

/**
 * Purges des données de connexion, aux délais qu'annonce la politique de
 * confidentialité publiée : un jour après l'expiration d'un code de connexion,
 * trente jours après la fin de validité (et la révocation) d'une session.
 *
 * Le worker n'a aucun droit sur `sessions` ni sur `email_login_codes` : les
 * bornes vivent dans deux fonctions SECURITY DEFINER sans argument
 * (`0169_worker_retention_purges.sql`), qu'il ne peut qu'appeler. Changer un
 * délai, c'est une migration ET le texte publié.
 */
export async function purgeSpentEmailLoginCodes(db: SQL): Promise<number> {
  const rows = await db<Array<{ count: string | number }>>`select public.purge_spent_email_login_codes() as count`;
  return Number(rows[0]?.count ?? 0);
}

export async function purgeDeadSessions(db: SQL): Promise<number> {
  const rows = await db<Array<{ count: string | number }>>`select public.purge_dead_sessions() as count`;
  return Number(rows[0]?.count ?? 0);
}
