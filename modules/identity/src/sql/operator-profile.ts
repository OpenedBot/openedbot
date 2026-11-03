import { isoInstant } from "@openedbot/contracts-primitives";
import type { TransactionDb } from "@openedbot/platform-db";

/** `OperatorProfileDto` de l'organisation, `null` tant qu'aucun handle n'est choisi. */
export async function readOperatorProfile(
  tx: TransactionDb,
  organizationId: string,
): Promise<{ username: string; updatedAt: string } | null> {
  const rows = await tx<Array<{ username: string; updatedAt: Date | string }>>`
    select username, updated_at as "updatedAt" from operator_profiles
     where organization_id = ${organizationId}
  `;
  const row = rows[0];
  return row ? { ...row, updatedAt: isoInstant(row.updatedAt) } : null;
}
