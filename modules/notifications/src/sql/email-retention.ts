import type { SQL } from "bun";

/**
 * Délai annoncé par la politique de confidentialité publiée : le changer ici
 * oblige à changer ce texte.
 */
export const DELIVERED_EMAIL_RETENTION_DAYS = 90;

/**
 * Un e-mail envoyé ou abandonné garde dans `email_outbox` l'adresse du
 * destinataire et le contenu du message. Au-delà de quatre-vingt-dix jours, il
 * ne sert plus à protéger un rejeu (la clé d'unicité joue sur quelques minutes)
 * ni à expliquer une livraison : la ligne part. Son journal de livraison
 * (`email_outbox_events`) reste : il ne porte ni adresse ni contenu, et le
 * worker n'a volontairement aucun droit de le relire.
 *
 * Une ligne `pending` ou `sending` n'est jamais touchée, même vieille : c'est
 * un e-mail qui n'est pas parti, un défaut à voir, pas une ligne à effacer.
 */
export async function purgeDeliveredEmails(db: SQL, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DELIVERED_EMAIL_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  const rows = await db<Array<{ count: string | number }>>`
    with deleted as (
      delete from email_outbox
       where status in ('sent', 'failed')
         and coalesce(sent_at, created_at) < ${cutoff}
       returning id
    )
    select count(*) as count from deleted
  `;
  return Number(rows[0]?.count ?? 0);
}
