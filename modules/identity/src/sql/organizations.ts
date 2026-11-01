import type { TransactionDb } from "@openedbot/platform-db";

/**
 * Règle le mode d'affectation des modèles de l'organisation (`per_bot` ou
 * `global`). Rend le mode écrit, ou null quand l'organisation n'existe plus.
 */
export async function setModelAssignmentMode(
  tx: TransactionDb,
  organizationId: string,
  mode: string,
): Promise<string | null> {
  const rows = await tx<Array<{ mode: string }>>`
    update organizations set model_assignment_mode = ${mode}, updated_at = now()
     where id = ${organizationId} and deleted_at is null
     returning model_assignment_mode as "mode"
  `;
  return rows[0]?.mode ?? null;
}
