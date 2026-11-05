/**
 * PERM2-6: read, add and remove natural-language permission
 * rules, per bot and per organization.
 *
 * A rule is read by the automatic reviewer only (`approval-review.ts`), as
 * fenced data: it cannot relax an interdiction, the floor, the deletion
 * stage, a `block` or the command blocklist, which the pipeline decides
 * before any review. Every write raises the permission revision of the bots
 * it concerns (trigger of 0145), so a verdict taken before it is redone.
 *
 * Roles are checked by the routes: a bot's rules are written by an owner, an
 * admin or a mandated agency; the organization's by an owner or an admin
 * only (D-5, checked again by the insert trigger).
 */

import {
  PERMISSION_RULES_MAX_PER_KIND,
  type PermissionRuleDto,
  type PermissionRuleInput,
  type PermissionRulesView,
} from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { isoInstant } from "@openedbot/contracts-primitives";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { isUniqueViolation, withTenant } from "@openedbot/platform-db";
import { readOrganizationPermissionPolicy } from "@openedbot/identity/sql/permission-policy";
import { permissionPipelineOf } from "@openedbot/runtimes/domain/runtime-contract";
import {
  countPermissionRules,
  deletePermissionRule,
  hasPermissionRuleText,
  insertPermissionRule,
  listPermissionRules,
} from "../sql/permission-rules";
import type { ToolPolicyActor } from "../sql/tool-policies";

export type PermissionRuleActor = ToolPolicyActor & { userId: string };

/** `null` is the organization scope. */
type Scope = { organizationId: string; botId: string | null };

async function readPipeline(tx: TransactionDb, scope: Scope, lock: boolean): Promise<string> {
  if (scope.botId === null) {
    const rows = lock
      ? await tx<Array<{ pipeline: string }>>`
        select permission_pipeline as pipeline from organizations where id = ${scope.organizationId} for update`
      : await tx<Array<{ pipeline: string }>>`
        select permission_pipeline as pipeline from organizations where id = ${scope.organizationId}`;
    if (!rows[0]) throw new HttpError(404, "ORGANIZATION_NOT_FOUND", "Organisation introuvable.");
    return rows[0].pipeline;
  }
  // The bot row is locked for a write: its rules are counted under it.
  const rows = lock
    ? await tx<Array<{ pipeline: string }>>`
      select o.permission_pipeline as pipeline
        from bots b join organizations o on o.id = b.organization_id
       where b.organization_id = ${scope.organizationId} and b.id = ${scope.botId} and b.deleted_at is null
       for update of b`
    : await tx<Array<{ pipeline: string }>>`
      select o.permission_pipeline as pipeline
        from bots b join organizations o on o.id = b.organization_id
       where b.organization_id = ${scope.organizationId} and b.id = ${scope.botId} and b.deleted_at is null`;
  if (!rows[0]) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
  return rows[0].pipeline;
}

function dto(row: { id: string; kind: string; text: string; createdAt: Date; createdByKind: "member" | "agency" }): PermissionRuleDto {
  return {
    id: row.id,
    // A kind this build does not know is shown as the stricter one, as the reviewer reads it.
    kind: row.kind === "allow" ? "allow" : "ask_first",
    text: row.text,
    createdAt: isoInstant(row.createdAt),
    createdByKind: row.createdByKind,
  };
}

async function view(tx: TransactionDb, scope: Scope, canWrite: boolean): Promise<PermissionRulesView> {
  const pipeline = await readPipeline(tx, scope, false);
  const policy = await readOrganizationPermissionPolicy(tx, scope.organizationId);
  return {
    scope: scope.botId === null ? "organization" : "bot",
    botId: scope.botId,
    rules: (await listPermissionRules(tx, scope.organizationId, scope.botId)).map(dto),
    writable: canWrite,
    enforced: permissionPipelineOf(pipeline) === "v2",
    rulesMode: policy?.rulesMode ?? "adds",
  };
}

export async function readPermissionRulesView(db: Db, scope: Scope, canWrite: boolean): Promise<PermissionRulesView> {
  return withTenant(db, scope.organizationId, (tx) => view(tx, scope, canWrite));
}

function limitError(): HttpError {
  return new HttpError(
    409,
    "PERMISSION_RULES_LIMIT",
    `Au plus ${PERMISSION_RULES_MAX_PER_KIND} règles de ce type : supprimez-en une avant d’en ajouter une autre.`,
    {},
    { max: PERMISSION_RULES_MAX_PER_KIND },
  );
}

/** The cap trigger of 0145, reached by a concurrent addition the count did not see. */
function isRulesLimitViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const details = error as { errno?: unknown; code?: unknown; hint?: unknown; message?: unknown };
  const state = details.errno ?? details.code;
  return state === "23514" && (details.hint === "PERMISSION_RULES_LIMIT" || String(details.message ?? "").includes("at most 20 permission rules"));
}

/**
 * Adds a rule. Refused under the legacy pipeline (nothing would read it),
 * past the cap of its (scope, kind), and when the same text is already a
 * rule of this scope, case ignored.
 */
export async function addPermissionRule(
  db: Db,
  scope: Scope,
  actor: PermissionRuleActor,
  input: PermissionRuleInput,
): Promise<PermissionRulesView> {
  if (scope.botId === null && actor.kind !== "member") {
    throw new HttpError(403, "ROLE_REQUIRED", "Seuls le propriétaire et les administrateurs modifient les règles de l’organisation.");
  }
  return withTenant(db, scope.organizationId, async (tx) => {
    const pipeline = await readPipeline(tx, scope, true);
    if (permissionPipelineOf(pipeline) !== "v2") {
      throw new HttpError(409, "PERMISSION_RULES_REQUIRE_V2", "Les règles s’appliquent avec le nouveau moteur de permissions, pas encore actif pour cette organisation.");
    }
    if (await countPermissionRules(tx, scope.organizationId, scope.botId, input.kind) >= PERMISSION_RULES_MAX_PER_KIND) throw limitError();
    if (await hasPermissionRuleText(tx, scope.organizationId, scope.botId, input.text)) {
      throw new HttpError(409, "PERMISSION_RULE_DUPLICATE", "Cette règle existe déjà.");
    }
    try {
      await insertPermissionRule(tx, { organizationId: scope.organizationId, botId: scope.botId, kind: input.kind, text: input.text, actor });
    } catch (error) {
      if (isRulesLimitViolation(error)) throw limitError();
      if (isUniqueViolation(error)) throw new HttpError(409, "PERMISSION_RULE_DUPLICATE", "Cette règle existe déjà.");
      throw error;
    }
    return view(tx, scope, true);
  });
}

/** Removes a rule of this scope; a rule already gone answers 404. Allowed under either pipeline. */
export async function removePermissionRule(db: Db, scope: Scope, ruleId: string): Promise<PermissionRulesView> {
  return withTenant(db, scope.organizationId, async (tx) => {
    await readPipeline(tx, scope, true);
    if (!(await deletePermissionRule(tx, scope.organizationId, scope.botId, ruleId))) {
      throw new HttpError(404, "PERMISSION_RULE_NOT_FOUND", "Cette règle n’existe plus.");
    }
    return view(tx, scope, true);
  });
}
