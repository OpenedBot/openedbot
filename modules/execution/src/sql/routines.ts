import type { TransactionDb } from "@openedbot/platform-db";

/**
 * Les routines d'un membre révoqué cessent de tirer au nom d'un compte sans
 * accès. Appelée par identity dans la transaction qui révoque la membership.
 */
export async function pauseMemberRoutines(tx: TransactionDb, organizationId: string, userId: string): Promise<void> {
  await tx`update routines set enabled = false, next_run_at = null, updated_at = now()
    where organization_id = ${organizationId} and created_by_user_id = ${userId}`;
}

/**
 * Une routine créée DÉSACTIVÉE, sans prochaine échéance. Appelée par
 * marketplace et portability dans la transaction de l'installation d'un modèle ou de l'import.
 */
export async function insertDisabledRoutine(
  tx: TransactionDb,
  input: {
    id: string;
    organizationId: string;
    botId: string;
    userId: string;
    name: string;
    schedule: string;
    message: string;
  },
): Promise<void> {
  await tx`
    insert into routines (
      id, organization_id, bot_id, created_by_user_id, name, schedule,
      timezone, message, enabled, next_run_at
    ) values (
      ${input.id}, ${input.organizationId}, ${input.botId}, ${input.userId}, ${input.name},
      ${input.schedule},
      'UTC', ${input.message}, false, null
    )
  `;
}
