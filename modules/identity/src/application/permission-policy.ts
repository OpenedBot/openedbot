import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { isoInstant } from "@openedbot/contracts-primitives";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import {
  normalizeCommandBlocklist,
  PERMISSION_CEILINGS,
  PERMISSION_RULES_MODES,
  type OrganizationPermissionPolicyInput,
  type OrganizationPermissionPolicyView,
  type PermissionCeiling,
  type PermissionRulesMode,
  type WorkspaceRole,
} from "@openedbot/contracts-api";
import {
  readOrganizationPermissionPipeline,
  readOrganizationPermissionPolicy,
  writeOrganizationPermissionPolicy,
} from "../sql/permission-policy";

/** What other packages call here; the SQL file stays private to the module. */
export {
  readOrganizationPermissionPipeline,
  readOrganizationPermissionPolicy,
  type OrganizationPermissionPolicyRow,
} from "../sql/permission-policy";

/** PERM2-8: owners and admins write the policy; agencies never do (D-5). */
export function canEditPermissionPolicy(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

export async function readPermissionPolicyView(
  db: Db,
  auth: { organizationId: string; role: WorkspaceRole },
): Promise<OrganizationPermissionPolicyView> {
  return withTenant(db, auth.organizationId, async (tx) => {
    const row = await readOrganizationPermissionPolicy(tx, auth.organizationId);
    const pipeline = await readOrganizationPermissionPipeline(tx, auth.organizationId);
    return {
      policy: {
        maxMode: row?.maxMode ?? null,
        enforceReview: row?.enforceReview ?? false,
        rulesMode: row?.rulesMode ?? "adds",
        commandBlocklist: row?.commandBlocklist ?? [],
        version: row?.version ?? 0,
        updatedAt: row?.updatedAt ? isoInstant(row.updatedAt) : null,
      },
      canEdit: canEditPermissionPolicy(auth.role),
      enforced: pipeline === "v2",
    };
  });
}

function invalid(field: string, message: string, details: Record<string, unknown> = {}): HttpError {
  return new HttpError(400, "PERMISSION_POLICY_INVALID", message, {}, { field, ...details });
}

/** The body of `PUT /api/organization/permissions`, canonical or refused. */
export function readPermissionPolicyInput(body: Record<string, unknown>): OrganizationPermissionPolicyInput {
  const maxMode = body.maxMode ?? null;
  if (maxMode !== null && !(PERMISSION_CEILINGS as readonly unknown[]).includes(maxMode)) {
    throw invalid("maxMode", "Plafond inconnu.");
  }
  if (typeof body.enforceReview !== "boolean") throw invalid("enforceReview", "La revue imposée doit être vraie ou fausse.");
  if (!(PERMISSION_RULES_MODES as readonly unknown[]).includes(body.rulesMode)) throw invalid("rulesMode", "Mode de règles inconnu.");
  const expectedVersion = body.expectedVersion;
  if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw invalid("expectedVersion", "La version attendue est invalide.");
  }
  const blocklist = normalizeCommandBlocklist(body.commandBlocklist ?? []);
  if (!blocklist.ok) {
    throw new HttpError(400, "PERMISSION_BLOCKLIST_INVALID", "La liste de commandes interdites est invalide.", {}, {
      issue: blocklist.issue,
      ...(blocklist.index === null ? {} : { index: blocklist.index }),
    });
  }
  return {
    maxMode: maxMode as PermissionCeiling | null,
    enforceReview: body.enforceReview,
    rulesMode: body.rulesMode as PermissionRulesMode,
    commandBlocklist: blocklist.entries,
    expectedVersion,
  };
}

/**
 * Saves the policy. The role is checked here for a readable refusal and
 * again by the definer function, which only trusts a live owner or admin
 * membership of the organization bound to the transaction.
 */
export async function savePermissionPolicy(
  db: Db,
  auth: { organizationId: string; userId: string; role: WorkspaceRole },
  input: OrganizationPermissionPolicyInput,
): Promise<OrganizationPermissionPolicyView> {
  if (!canEditPermissionPolicy(auth.role)) {
    throw new HttpError(403, "ROLE_REQUIRED", "Seuls le propriétaire et les administrateurs modifient cette politique.");
  }
  const result = await withTenant(db, auth.organizationId, (tx) => writeOrganizationPermissionPolicy(tx, {
    organizationId: auth.organizationId,
    actorUserId: auth.userId,
    ...input,
  }));
  if (result.status === "conflict") {
    throw new HttpError(409, "PERMISSION_POLICY_CONFLICT", "La politique a changé entre-temps. Rechargez-la avant de l’enregistrer.", {}, { version: result.version });
  }
  if (result.status === "pipeline_legacy") {
    throw new HttpError(409, "PERMISSION_POLICY_REQUIRES_PIPELINE", "Cette politique ne s’applique qu’avec le nouveau moteur de permissions, pas encore actif pour cette organisation.");
  }
  return readPermissionPolicyView(db, auth);
}
