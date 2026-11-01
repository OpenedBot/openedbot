import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { permissionModeRaiseRefused, type BotPermissionMode, type PermissionCeiling } from "@openedbot/contracts-api";
import { readOrganizationPermissionPolicy } from "@openedbot/identity/sql/permission-policy";

/** The organization's ceiling (PERM2-8), `null` when none is set. */
export async function readPermissionCeiling(db: Db, organizationId: string): Promise<PermissionCeiling | null> {
  const policy = await withTenant(db, organizationId, (tx) => readOrganizationPermissionPolicy(tx, organizationId));
  return policy?.maxMode ?? null;
}

/**
 * PERM2-8: a bot mode is never RAISED above the organization's ceiling, on
 * any write path (PATCH, creation, Marketplace). Lowering is always allowed
 * and a bot already above stays stored; the pipeline caps its effective
 * mode. Trigger `bots_permission_ceiling_guard` (0142) is the backstop.
 */
export async function assertPermissionModeUnderCeiling(
  db: Db,
  organizationId: string,
  next: BotPermissionMode,
  previous: BotPermissionMode | null,
): Promise<void> {
  if (next === "plan" || next === "manual") return;
  const ceiling = await readPermissionCeiling(db, organizationId);
  if (permissionModeRaiseRefused(next, previous, ceiling)) {
    throw new HttpError(403, "PERMISSION_MODE_ABOVE_CEILING", "Limité par votre organisation : ce mode dépasse le plafond fixé par le propriétaire ou un administrateur.", {}, { ceiling });
  }
}
