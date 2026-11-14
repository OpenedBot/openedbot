import type { SQL } from "bun";
import type { PermissionCeiling, PermissionRulesMode } from "@openedbot/contracts-api";
import { pgTextArray } from "@openedbot/platform-db/text-array";

/**
 * PERM2-8 (migration 0142): the organization permission policy. Read by the
 * API tenant, the roster (ceiling on bot mode writes) and the worker
 * pipeline; written only through `set_organization_permission_policy`.
 */
export type OrganizationPermissionPolicyRow = {
  maxMode: PermissionCeiling | null;
  enforceReview: boolean;
  rulesMode: PermissionRulesMode;
  commandBlocklist: string[];
  version: number;
  updatedAt: Date | null;
};

type RawRow = {
  maxMode: string | null;
  enforceReview: boolean;
  rulesMode: string;
  commandBlocklist: unknown;
  version: number | string;
  updatedAt: Date | string | null;
};

function ceilingOf(value: string | null): PermissionCeiling | null {
  // A stored value this code does not know caps at the most restrictive
  // ceiling: an unknown policy never widens what a bot may do.
  if (value === null) return null;
  return value === "auto" || value === "bypass" || value === "manual" ? value : "manual";
}

/** `null` when the organization never saved a policy: no ceiling, no blocklist. */
export async function readOrganizationPermissionPolicy(tx: SQL, organizationId: string): Promise<OrganizationPermissionPolicyRow | null> {
  // The worker's policy reads every organization: the filter is the tenant.
  const rows = await tx<RawRow[]>`
    select max_mode as "maxMode", enforce_review as "enforceReview", rules_mode as "rulesMode",
           array_to_json(command_blocklist) as "commandBlocklist", version, updated_at as "updatedAt"
      from organization_permission_policies
     where organization_id = ${organizationId}
  `;
  const row = rows[0];
  if (!row) return null;
  const blocklist = Array.isArray(row.commandBlocklist)
    ? row.commandBlocklist.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    maxMode: ceilingOf(row.maxMode),
    enforceReview: row.enforceReview === true,
    rulesMode: row.rulesMode === "replaces" ? "replaces" : "adds",
    commandBlocklist: blocklist,
    version: Number(row.version),
    updatedAt: row.updatedAt === null ? null : new Date(row.updatedAt),
  };
}

export async function readOrganizationPermissionPipeline(tx: SQL, organizationId: string): Promise<string | null> {
  const rows = await tx<Array<{ pipeline: string }>>`
    select permission_pipeline as pipeline from organizations where id = ${organizationId}
  `;
  return rows[0]?.pipeline ?? null;
}

export type PermissionPolicyWriteStatus = "saved" | "unchanged" | "conflict" | "pipeline_legacy";

/** The one write; the definer function proves the actor is a live owner or admin member. */
export async function writeOrganizationPermissionPolicy(
  tx: SQL,
  input: {
    organizationId: string;
    actorUserId: string;
    maxMode: PermissionCeiling | null;
    enforceReview: boolean;
    rulesMode: PermissionRulesMode;
    commandBlocklist: readonly string[];
    expectedVersion: number;
  },
): Promise<{ status: PermissionPolicyWriteStatus; version: number }> {
  const rows = await tx<Array<{ status: PermissionPolicyWriteStatus; version: number | string }>>`
    select status, version from set_organization_permission_policy(
      ${input.organizationId}::uuid, ${input.actorUserId}::uuid, ${input.maxMode}::text, ${input.enforceReview}::boolean,
      ${input.rulesMode}::text, ${pgTextArray(input.commandBlocklist)}::text[], ${input.expectedVersion}::bigint
    )
  `;
  const row = rows[0];
  if (!row) throw new Error("set_organization_permission_policy returned no row");
  return { status: row.status, version: Number(row.version) };
}
