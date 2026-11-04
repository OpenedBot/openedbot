import { GROUP_MEMBERS_MIN } from "@openedbot/contracts-api";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { pgTextArray } from "@openedbot/platform-db/text-array";

/** Ce que la suppression définitive d'un bot fait autour de sa ligne : salons et octets. */

/**
 * Retire un bot de tous ses salons ; un salon qui passerait sous
 * `GROUP_MEMBERS_MIN` est supprimé (son fil et ses routines suivent en
 * cascade). Un salon conservé dont il était le pilote passe au premier membre
 * restant, sans quoi sa règle nommerait un non-membre et la lecture du roster
 * entier échouerait. Rend `{ left, deleted }` : salons quittés, salons supprimés.
 */
export async function detachBotFromGroups(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<{ left: number; deleted: number }> {
  const memberships = await tx<Array<{ groupId: string }>>`
    delete from group_members
     where organization_id = ${organizationId} and bot_id = ${botId}
    returning group_id as "groupId"
  `;
  if (memberships.length === 0) return { left: 0, deleted: 0 };
  const groupIds = memberships.map((row) => row.groupId);
  const removed = await tx<Array<{ id: string }>>`
    delete from bot_groups g
     where g.organization_id = ${organizationId}
       and g.id = any(${pgTextArray(groupIds)}::text[]::uuid[])
       and (select count(*) from group_members m
             where m.organization_id = g.organization_id and m.group_id = g.id) < ${GROUP_MEMBERS_MIN}
    returning id
  `;
  await tx`
    update bot_groups g
       set default_responder = jsonb_build_object('kind', 'member', 'botId', (
             select m.bot_id::text from group_members m
              where m.organization_id = g.organization_id and m.group_id = g.id
              order by m.position, m.bot_id limit 1
           )),
           updated_at = now()
     where g.organization_id = ${organizationId}
       and g.id = any(${pgTextArray(groupIds)}::text[]::uuid[])
       and g.default_responder->>'kind' = 'member'
       and g.default_responder->>'botId' = ${botId}::uuid::text
  `;
  return { left: memberships.length, deleted: removed.length };
}

/**
 * Les octets que la cascade d'un bot emporterait sans plus pouvoir les
 * retrouver : pièces jointes des messages de ses fils et manifestes
 * d'ingestion de ces fils. Leurs clés entrent dans la file durable de
 * suppression, dans la transaction qui supprime le bot.
 */
export async function queueBotBlobDeletionsTx(tx: Db, organizationId: string, botId: string): Promise<void> {
  await tx`
    with object_keys as (
      select a.object_key as key, a.driver from attachments a
        join messages m on m.organization_id = a.organization_id and m.id = a.message_id
        join threads t on t.organization_id = m.organization_id and t.id = m.thread_id
       where a.organization_id = ${organizationId} and t.bot_id = ${botId}
      union
      select item->>'key' as key, null as driver from message_ingress ingress
        join threads t on t.organization_id = ingress.organization_id and t.id = ingress.thread_id
        cross join lateral jsonb_array_elements(ingress.attachment_manifest) item
       where ingress.organization_id = ${organizationId} and t.bot_id = ${botId}
         and jsonb_typeof(item) = 'object' and item ? 'key'
    )
    insert into tenant_blob_deletions (object_key, organization_id, driver)
    select distinct on (key) key, ${organizationId}, driver from object_keys where key is not null
     order by key, driver nulls last
    on conflict (object_key) do nothing
  `;
}
