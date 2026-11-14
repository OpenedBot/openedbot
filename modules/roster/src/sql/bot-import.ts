import type { Db } from "@openedbot/platform-db";
import { AUTONOMY_DEFAULTS } from "../domain/autonomous-workflow";
import { queueBotBlobDeletionsTx } from "./bot-purge";

/**
 * Writes of the roster tables on behalf of the profile import and the profile
 * delete of portability. The SQL lives with its owner; the caller passes its
 * own transaction.
 */

/** Le bot d'un profil Hermes importé, avec les bornes d'autonomie par défaut. */
export async function insertImportedBot(
  tx: Db,
  input: {
    botId: string;
    organizationId: string;
    sectionId: string;
    name: string;
    slug: string;
    description: string | null;
    instructions: string;
    model: string | null;
    managed: boolean;
    position: number;
    pinned: boolean;
    face: unknown;
    /** D-1: `defaultPermissionMode` of the organization. */
    permissionMode: "auto" | "manual";
  },
): Promise<void> {
  await tx`
    insert into bots (
      id, organization_id, section_id, name, slug, description, instructions, model,
      reasoning_effort, hermes_profile, hermes_profile_managed, position, pinned, face, permission_mode,
      autonomy_enabled, autonomy_max_depth, autonomy_max_steps, autonomy_max_handoffs,
      autonomy_timeout_seconds, autonomy_token_budget
    ) values (
      ${input.botId}, ${input.organizationId}, ${input.sectionId}, ${input.name}, ${input.slug}, ${input.description}, ${input.instructions}, ${input.model},
      null, ${input.slug}, ${input.managed}, ${input.position}, ${input.pinned}, ${input.face}, ${input.permissionMode},
      ${AUTONOMY_DEFAULTS.enabled}, ${AUTONOMY_DEFAULTS.maxDepth}, ${AUTONOMY_DEFAULTS.maxSteps}, ${AUTONOMY_DEFAULTS.maxHandoffs},
      ${AUTONOMY_DEFAULTS.timeoutSeconds}, ${AUTONOMY_DEFAULTS.tokenBudget}
    )
  `;
}

/** Le salon d'un groupe de profils importés : tout le monde peut répondre. */
export async function insertImportedBotGroup(
  tx: Db,
  input: { groupId: string; organizationId: string; sectionId: string; name: string; position: number },
): Promise<void> {
  await tx`
    insert into bot_groups (id, organization_id, section_id, name, instructions, default_responder, position)
    values (${input.groupId}, ${input.organizationId}, ${input.sectionId}, ${input.name}, ${""}, ${{ kind: "everyone" }}, ${input.position})
  `;
}

/** Un membre de salon, à son rang. */
export async function insertGroupMember(
  tx: Db,
  input: { organizationId: string; groupId: string; botId: string; position: number },
): Promise<void> {
  await tx`insert into group_members (organization_id, group_id, bot_id, position) values (${input.organizationId}, ${input.groupId}, ${input.botId}, ${input.position})`;
}

/**
 * La suppression du profil hôte de ce bot est engagée : l'état est durable et
 * archive le bot, donc toute admission (message, routine, webhook, relais) le
 * refuse jusqu'au nettoyage final. Le bot doit déjà être verrouillé. Rend
 * l'état d'avant, pour pouvoir le rendre si rien n'a touché au profil.
 */
export async function markBotHostProfileDeleting(
  tx: Db,
  organizationId: string,
  botId: string,
): Promise<{ alreadyDeleting: boolean; wasArchived: boolean } | null> {
  const rows = await tx<Array<{ alreadyDeleting: boolean; wasArchived: boolean }>>`
    with before as (
      select host_profile_deleting_at is not null as deleting, archived_at is not null as archived
        from bots where organization_id = ${organizationId} and id = ${botId}
    )
    update bots b
       set host_profile_deleting_at = coalesce(b.host_profile_deleting_at, now()),
           archived_at = coalesce(b.archived_at, now()),
           updated_at = now()
      from before
     where b.organization_id = ${organizationId} and b.id = ${botId}
    returning before.deleting as "alreadyDeleting", before.archived as "wasArchived"
  `;
  return rows[0] ?? null;
}

/** Rend le bot tel qu'il était quand la tentative a échoué avant tout effet sur le profil. */
export async function releaseBotHostProfileDeleting(
  tx: Db,
  organizationId: string,
  botId: string,
  wasArchived: boolean,
): Promise<void> {
  await tx`
    update bots
       set host_profile_deleting_at = null,
           archived_at = case when ${wasArchived} or deleted_at is not null then archived_at else null end,
           updated_at = now()
     where organization_id = ${organizationId} and id = ${botId} and host_profile_deleting_at is not null
  `;
}

/** Le bot dont la suppression du profil `slug` a été engagée puis interrompue, verrouillé. */
export async function lockBotWithHostProfileDeleting(tx: Db, organizationId: string, slug: string): Promise<string | null> {
  const rows = await tx<Array<{ id: string }>>`
    select id from bots
     where organization_id = ${organizationId} and hermes_profile = ${slug}
       and host_profile_deleting_at is not null
     for update
  `;
  return rows[0]?.id ?? null;
}

/** Le bot d'un profil supprimé sur l'hôte : la ligne part avec lui, ses octets entrent en file. */
export async function deleteBotAfterHostProfileDelete(tx: Db, organizationId: string, botId: string): Promise<void> {
  await queueBotBlobDeletionsTx(tx, organizationId, botId);
  await tx`
    delete from bots where organization_id = ${organizationId} and id = ${botId}
  `;
}
