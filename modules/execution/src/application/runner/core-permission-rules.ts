/**
 * The core's `PermissionRuleSource`: the rules every organization is decided
 * under without the plug-in `permissions` (solo), or without `permissions.v2`.
 * The reads, their order and their tenant binding are the ones the gate made
 * itself before the port (PERM2-4, PERM2-5, PERM2-8), and the ones the
 * reviewer (PERM2-6) and the unattended gates (PERM2-9) made before theirs.
 */
import type { SQL } from "bun";
import { readTerminalAlwaysTx } from "@openedbot/runtimes/sql/permission-settings";
import { activeGrantIdTx } from "@openedbot/roster/sql/permission-grants";
import { readReviewRulesTx } from "@openedbot/roster/sql/permission-rules";
import { readToolPolicyTx } from "@openedbot/roster/sql/tool-policies";
import {
  NO_GRANTS,
  NO_ORGANIZATION_POLICY,
  type OrganizationPermissionPolicy,
  type PermissionGrants,
  type PermissionRuleQuery,
  type ResolvedPermissionRuleSource,
  type ReviewRuleQuery,
  type ReviewRules,
  type UnattendedQuery,
} from "../../domain/permission-rules";

/**
 * PERM2-8: read under the organization lock the gate holds; its writer
 * (`set_organization_permission_policy`) locks that row `for update` first,
 * so a decision never straddles a policy change. A stored value this code
 * does not know caps at `manual`: an unknown policy never widens a bot.
 */
async function readOrganizationPolicyTx(tx: SQL, organizationId: string): Promise<OrganizationPermissionPolicy> {
  const rows = await tx<Array<{ ceiling: string | null; enforceReview: boolean; commandBlocklist: unknown }>>`
    select max_mode as ceiling, enforce_review as "enforceReview", array_to_json(command_blocklist) as "commandBlocklist"
      from organization_permission_policies where organization_id = ${organizationId}
  `;
  const row = rows[0];
  if (!row) return NO_ORGANIZATION_POLICY;
  const ceiling = row.ceiling === null ? null : row.ceiling === "auto" || row.ceiling === "bypass" ? row.ceiling : "manual";
  // An entry that is not text is kept as an unmatchable string, never dropped:
  // a non-empty list still refuses an unreadable command.
  const commandBlocklist = Array.isArray(row.commandBlocklist) ? row.commandBlocklist.map(String) : [];
  return { ceiling, enforceReview: row.enforceReview === true, commandBlocklist };
}

/**
 * PERM2-4: the grant for this gate's tool, and the runtime terminal switch.
 * Both tables are tenant-scoped for the worker too (0140): this transaction
 * is the run's, so it is bound to the run's organization for the read,
 * and every query still filters on it. Read after the bot's `for share`: a
 * grant or a switch committed later raises the revision this decision
 * records, and the forwarding claim redoes it.
 */
async function readGrantsTx(tx: SQL, query: PermissionRuleQuery): Promise<PermissionGrants> {
  const grantable = query.gateKind === "plugin_tool" && query.toolKey !== null;
  const terminal = query.gateKind === "terminal_danger";
  if (!grantable && !terminal) return NO_GRANTS;
  // Put the previous tenant back, as the tool policy read does: the rest of
  // `persistEvents` runs under the setting it had.
  const rows = await tx<Array<{ previous: string }>>`
    select coalesce(current_setting('app.organization_id', true), '') as previous
  `;
  await tx`select set_config('app.organization_id', ${query.organizationId}, true)`;
  try {
    return {
      grantId: grantable ? await activeGrantIdTx(tx, query.organizationId, query.botId, query.toolKey!) : null,
      terminalAlways: terminal ? await readTerminalAlwaysTx(tx, query.organizationId) : false,
    };
  } finally {
    await tx`select set_config('app.organization_id', ${rows[0]?.previous ?? ""}, true)`;
  }
}

/**
 * PERM2-6: the rules and the mode in one transaction, so they agree. The
 * rules table is tenant-scoped for the worker (0145); the policy table is
 * filtered on the organization explicitly.
 */
async function readReviewRulesOfTx(tx: SQL, query: ReviewRuleQuery): Promise<ReviewRules> {
  const policy = await tx<Array<{ rulesMode: string }>>`
    select rules_mode as "rulesMode" from organization_permission_policies where organization_id = ${query.organizationId}
  `;
  const rules = await readReviewRulesTx(tx, query.organizationId, query.botId);
  return { rulesMode: policy[0]?.rulesMode ?? null, rules };
}

/** PERM2-9: the workflow's snapshot of the routine's "Never wait", taken when it fired (0144). */
async function readNeverWaitTx(tx: SQL, query: UnattendedQuery): Promise<boolean> {
  const rows = await tx<Array<{ neverWait: boolean }>>`
    select never_wait as "neverWait" from workflows
     where organization_id = ${query.organizationId} and id = ${query.workflowId}
  `;
  return rows[0]?.neverWait === true;
}

export const corePermissionRuleSource: ResolvedPermissionRuleSource = {
  async read(transaction, query) {
    const tx = transaction as SQL;
    const organizationPolicy = await readOrganizationPolicyTx(tx, query.organizationId);
    // PERM2-5: read under the bot lock; every write raises the revision (0141).
    const toolPolicy = query.toolKey ? await readToolPolicyTx(tx, query.organizationId, query.botId, query.toolKey) : null;
    const grants = await readGrantsTx(tx, query);
    return { organizationPolicy, toolPolicy, grants };
  },
  reviewRules: (transaction, query) => readReviewRulesOfTx(transaction as SQL, query),
  unattended: (transaction, query) => readNeverWaitTx(transaction as SQL, query),
};
