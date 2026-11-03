import type { Db } from "@openedbot/platform-db";
import { AUTONOMY_DEFAULTS } from "../domain/autonomous-workflow";

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

/** Le bot d'un profil supprimé sur l'hôte : la ligne part avec lui. */
export async function deleteBotAfterHostProfileDelete(tx: Db, organizationId: string, botId: string): Promise<void> {
  await tx`
    delete from bots where organization_id = ${organizationId} and id = ${botId}
  `;
}
