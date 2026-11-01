import type { ModelAssignmentMode, RuntimeAdminMode, RuntimeMode } from "@openedbot/contracts-api";
import type { ApiConfig } from "@openedbot/platform-config/api-config";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";


/** Compatibility helpers: no organization mode is read or persisted. */
export function runtimeModeAllowed(mode: RuntimeMode, _config: ApiConfig): boolean {
  return mode === "external";
}

export function effectiveAdminMode(_config: ApiConfig, _mode: RuntimeMode): RuntimeAdminMode {
  return "disabled";
}


export async function readOrganizationRuntimeModeIn(
  _tx: TransactionDb,
  _config: ApiConfig,
  _organizationId: string,
): Promise<RuntimeMode> {
  return "external";
}

export async function readOrganizationRuntimeMode(
  db: Db,
  config: ApiConfig,
  organizationId: string,
): Promise<RuntimeMode> {
  return withTenant(db, organizationId, (tx) => readOrganizationRuntimeModeIn(tx, config, organizationId));
}

/**
 * Le mode d'attribution des modèles de l'organisation.
 *
 * Une colonne absente (serveur en avance sur sa base, migration non jouée) vaut
 * `per_bot` : le comportement d'avant la migration 0072, jamais une bascule
 * silencieuse de tous les bots vers le choix global.
 */
export async function readModelAssignmentModeIn(
  tx: TransactionDb,
  organizationId: string,
): Promise<ModelAssignmentMode> {
  const rows = await tx<Array<{ mode: string | null }>>`
    select model_assignment_mode as "mode" from organizations where id = ${organizationId}
  `;
  return rows[0]?.mode === "global" ? "global" : "per_bot";
}

export async function readModelAssignmentMode(
  db: Db,
  organizationId: string,
): Promise<ModelAssignmentMode> {
  return withTenant(db, organizationId, (tx) => readModelAssignmentModeIn(tx, organizationId));
}
