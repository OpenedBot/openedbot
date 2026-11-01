import type { SQL } from "bun";

/**
 * La rétention du guichet de support.
 *
 * Deux bornes, et deux raisons différentes :
 *
 * - les ÉVÉNEMENTS d'un fil fermé ne servent plus à personne au bout d'un
 *   mois. Ils n'existent que pour le flux SSE, et un fil fermé n'a plus
 *   d'abonné ; le fil lui-même reste lisible, il vit dans `support_messages`.
 *   Même borne et même raison que `purgeOldRunEvents`.
 * - le FIL entier, messages compris, part au bout de six mois de fermeture.
 *   C'est du contenu écrit par une personne qui n'a pas de compte chez nous et
 *   ne peut donc pas demander son effacement depuis un écran : le garder sans
 *   fin serait une collecte sans terme.
 *
 * Un fil OUVERT n'est jamais touché, quelle que soit son ancienneté : un
 * visiteur sans réponse depuis un an est un défaut de service, pas une ligne à
 * effacer en silence.
 */
export async function purgeOldSupportEvents(
  db: SQL,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  // Une borne concrète plutôt qu'un `interval` paramétré : l'inférence de Bun
  // SQL a déjà fait évaluer `timestamptz < interval` à PostgreSQL.
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
  const rows = await db<Array<{ count: string | number }>>`
    with deleted as (
      delete from support_events e
       where e.occurred_at < ${cutoff}
         and exists (
           select 1 from support_conversations c
            where c.id = e.conversation_id and c.status = 'closed'
         )
       returning e.cursor
    )
    select count(*) as count from deleted
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function purgeClosedSupportConversations(
  db: SQL,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
  // `updated_at` et non `created_at` : la borne court depuis le dernier geste
  // sur le fil, donc un échange long ne se fait pas couper en deux.
  // Les messages et les événements partent par cascade.
  //
  // Les CAPTURES, elles, ne partent pas par cascade : la ligne s'en va, mais
  // les octets vivent dans le magasin de blobs. Leurs clés entrent donc dans
  // la file durable de suppression (`tenant_blob_deletions`) DANS LA MÊME
  // instruction que la suppression du fil. Un seul `with` plutôt que deux
  // requêtes : entre les deux, un fil supprimé aurait emporté la seule ligne
  // qui savait où étaient ses octets, et ils seraient restés à payer sans que
  // personne ne puisse les retrouver.
  const rows = await db<Array<{ count: string | number }>>`
    with doomed as (
      select c.id from support_conversations c
       where c.status = 'closed' and c.updated_at < ${cutoff}
    ), queued as (
      insert into tenant_blob_deletions (object_key, organization_id)
      select a.object_key, null
        from support_attachments a
        join doomed d on d.id = a.conversation_id
      on conflict (object_key) do nothing
      returning object_key
    ), deleted as (
      delete from support_conversations c
       using doomed d
       where c.id = d.id
       returning c.id
    )
    select count(*) as count from deleted
  `;
  return Number(rows[0]?.count ?? 0);
}
