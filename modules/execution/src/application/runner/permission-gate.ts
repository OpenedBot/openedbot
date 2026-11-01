/**
 * PERM2-1: who answers a gate, decided inside the transaction that persists
 * it (`persistEvents`), under the run lock it already holds. Every stage the
 * pipeline runs today is deterministic, so the gate is born either answered
 * or `awaiting_human`, in the same commit as its `approval.requested` event,
 * except a gate the reviewer answers (PERM2-7): it is born `reviewing`, and
 * no human read shows it until the reviewer escalates it.
 */

import type { SQL } from "bun";
import { parseYoloLease, RelayFrameError } from "@openedbot/contracts-connector";
import type { GateDescriptor, GateIdentity } from "../../domain/gate-identity";
import { readReviewProven } from "@openedbot/runtimes/sql/review-profiles";
import {
  decidePermission,
  effectivePermissionMode,
  humanChoiceStillAllowed,
  unattendedDecision,
  type PermissionDecision,
  type PermissionGate,
  type PermissionPolicy,
  type YoloGatePolicy,
} from "../../domain/permission-decision";
import { readGateYoloLeaseTx } from "../../sql/yolo-leases";
import type { PermissionRules } from "../../domain/permission-rules";
import { permissionRuleSourceFor } from "./permission-rule-sources";

export type GateResolution =
  | { pipeline: "legacy" }
  | {
      pipeline: "v2";
      decision: PermissionDecision;
      /** The bot revision the decision was taken at. */
      revision: number;
      /** `once` / `deny` answered by the policy, `null` for a human or the reviewer. */
      choice: "once" | "deny" | null;
      detail: Record<string, unknown>;
    };

/**
 * Everything a `v2` gate is decided under: the bot's mode and revision and
 * the review proof, which the core reads, and the rules its
 * `PermissionRuleSource` reads (PERM2-4, PERM2-5, PERM2-8).
 */
export type GateState = {
  mode: string | null;
  revision: number | string;
  reviewProven: boolean;
  rules: PermissionRules;
  /** The active YOLO lease that covers the gate's run, if any. */
  yolo: YoloGatePolicy | null;
};

type PolicyRow = { pipeline: "legacy" } | ({ pipeline: "v2" } & GateState);

export function permissionGate(gate: GateIdentity, choices: readonly unknown[]): PermissionGate {
  const args = gate.gateArgs ?? {};
  return {
    kind: gate.gateKind,
    toolKey: gate.toolKey,
    descriptor: gate.gateKind === "plugin_tool" ? gate.gateArgs as GateDescriptor : null,
    command: gate.gateKind === "terminal_danger" && typeof args.command === "string" ? args.command : null,
    choices: choices.filter((choice): choice is string => typeof choice === "string"),
  };
}

/**
 * The policy a gate is decided under: the ceiling, enforced review and
 * blocklist are PERM2-8's, the tool policy PERM2-5's, the grant and the
 * terminal switch PERM2-4's. A plan-only turn (0155) is decided as `plan`,
 * the narrowest mode, whatever the bot's: it never widens a right.
 */
function policyOf(state: GateState, planOnly: boolean): PermissionPolicy {
  return {
    mode: planOnly ? "plan" : state.mode,
    ceiling: state.rules.organizationPolicy.ceiling,
    enforceReview: state.rules.organizationPolicy.enforceReview,
    reviewProven: state.reviewProven,
    toolPolicy: state.rules.toolPolicy,
    grantActive: state.rules.grants.grantId !== null,
    terminalAlways: state.rules.grants.terminalAlways,
    commandBlocklist: state.rules.organizationPolicy.commandBlocklist,
    yolo: state.yolo,
  };
}

/**
 * The YOLO lease that covers this run (migration 0158), read under the bot
 * lock: a grant or a revocation locks the organization `for update` and
 * raises the revision of the bots it covers, so the forwarding claim redoes
 * a decision taken before it. The table is tenant-scoped for the worker:
 * the read is bound to the run's organization, then the previous tenant is
 * put back, as `readGrantsTx` does. A stored payload this code cannot read
 * is no lease: it never widens a gate.
 */
async function readYoloTx(tx: SQL, context: GateRunContext, botId: string): Promise<YoloGatePolicy | null> {
  if (!context.runtimeId) return null;
  const rows = await tx<Array<{ previous: string }>>`
    select coalesce(current_setting('app.organization_id', true), '') as previous
  `;
  await tx`select set_config('app.organization_id', ${context.organizationId}, true)`;
  try {
    const row = await readGateYoloLeaseTx(tx, {
      organizationId: context.organizationId, runtimeId: context.runtimeId, botId, threadId: context.threadId ?? null,
    });
    if (!row) return null;
    const lease = parseYoloLease(row.payload);
    return { leaseId: row.id, deny: lease.deny, protect: lease.protect };
  } catch (error) {
    if (error instanceof RelayFrameError) return null;
    throw error;
  } finally {
    await tx`select set_config('app.organization_id', ${rows[0]?.previous ?? ""}, true)`;
  }
}

/**
 * Reads the organization's pipeline and the bot's policy. A `legacy` read
 * takes no lock: the switch to `v2` refuses while a run of the organization
 * holds a lease, which this run does. A `v2` read locks `for share`, the
 * organization first in its own statement (the switch locks it, then every
 * bot through the revision trigger: the same order cannot deadlock), so the
 * decision is taken at a revision nobody can move underneath it. The rules
 * come from the organization's `PermissionRuleSource`, chosen before the
 * locks and read under them.
 */
async function readPolicyTx(tx: SQL, context: GateRunContext, gate: GateIdentity): Promise<PolicyRow | null> {
  const { organizationId, botId } = context;
  const flags = await tx<Array<{ pipeline: string }>>`
    select permission_pipeline as pipeline from organizations where id = ${organizationId}
  `;
  if (!flags[0]) return null;
  if (flags[0].pipeline !== "v2") return { pipeline: "legacy" };
  const source = await permissionRuleSourceFor(organizationId);
  const organizations = await tx<Array<{ pipeline: string }>>`
    select permission_pipeline as pipeline from organizations where id = ${organizationId} for share
  `;
  const organization = organizations[0];
  if (!organization) return null;
  if (organization.pipeline !== "v2") return { pipeline: "legacy" };
  const bots = await tx<Array<{ mode: string | null; revision: number | string }>>`
    select permission_mode as mode, permission_revision as revision
      from bots where organization_id = ${organizationId} and id = ${botId}
     for share
  `;
  const bot = bots[0];
  if (!bot) return null;
  // PERM2-7a: without a fresh proof of the review profile, `auto` is `manual`.
  const reviewProven = await readReviewProven(tx, organizationId);
  const rules = await source.read(tx, { organizationId, botId, gateKind: gate.gateKind, toolKey: gate.toolKey });
  const yolo = await readYoloTx(tx, context, botId);
  return { pipeline: "v2", mode: bot.mode, revision: bot.revision, reviewProven, rules, yolo };
}


/**
 * The run a gate belongs to. `neverWait` is the snapshot its workflow took
 * from a routine with "Never wait" (PERM2-9, `workflows.never_wait`): nobody
 * is there to answer, so a human gate is refused at once. `planOnly`: the
 * operator asked this turn for a plan (`runs.plan_only`, 0155). `runtimeId`
 * and `threadId` find the YOLO lease that covers the run; without a runtime,
 * no lease applies.
 */
export type GateRunContext = {
  organizationId: string;
  botId: string;
  neverWait: boolean;
  planOnly?: boolean;
  runtimeId?: string;
  threadId?: string | null;
};

function decideV2(row: GateState, gate: GateIdentity, choices: readonly unknown[], context: GateRunContext): Extract<GateResolution, { pipeline: "v2" }> {
  // `review` only comes out with a proven review profile (effective mode
  // `auto`): the gate is born `reviewing` and the reviewer answers it (PERM2-7).
  const policy = policyOf(row, context.planOnly === true);
  const decision = unattendedDecision(decidePermission(permissionGate(gate, choices), policy), context.neverWait);
  // The rule that lowered the bot's mode is named, never silent.
  const lowered = effectivePermissionMode(policy).reason;
  return {
    pipeline: "v2",
    decision,
    revision: Number(row.revision),
    choice: decision.outcome === "once" ? "once" : decision.outcome === "deny" ? "deny" : null,
    detail: {
      reason: decision.reason,
      effectiveMode: decision.effectiveMode,
      ...(lowered ? { effectiveReason: lowered } : {}),
      ...(decision.yoloLeaseId ? { yoloLeaseId: decision.yoloLeaseId } : {}),
      ...(decision.heldBy ? { heldStage: decision.heldBy.stage, heldReason: decision.heldBy.reason } : {}),
      // PERM2-11: the journal names the grant that answered, and its author.
      ...(decision.stage === "grant" && decision.reason === "grant" && row.rules.grants.grantId
        ? { grantId: row.rules.grants.grantId } : {}),
    },
  };
}

export async function resolveGateTx(
  tx: SQL,
  context: GateRunContext,
  gate: GateIdentity,
  choices: readonly unknown[],
): Promise<GateResolution> {
  const row = await readPolicyTx(tx, context, gate);
  // A bot gone mid-run, or a legacy organization: today's behavior.
  if (!row || row.pipeline !== "v2") return { pipeline: "legacy" };
  return decideV2(row, gate, choices, context);
}

export type ForwardCheck =
  | { action: "forward" }
  | { action: "deny"; reason: string }
  | { action: "redecide"; resolution: Extract<GateResolution, { pipeline: "v2" }> };

/**
 * The linearization point of a `v2` decision: the forwarding claim reads the
 * bot's revision again, in its own transaction and `for share`. A policy
 * decision taken at an older revision is redone; a human `once` that became
 * forbidden is sent as `deny`. A change committed after this claim counts
 * for the next gate, not this one.
 */
export async function checkBeforeForwardTx(
  tx: SQL,
  context: GateRunContext,
  approval: {
    choice: "once" | "deny";
    decidedByKind: string | null;
    revisionSeen: number | string | null;
    gate: GateIdentity;
    choices: readonly unknown[];
  },
): Promise<ForwardCheck> {
  if (approval.decidedByKind === null) return { action: "forward" };
  const row = await readPolicyTx(tx, context, approval.gate);
  if (!row || row.pipeline !== "v2") return { action: "forward" };
  if (approval.decidedByKind !== "policy") {
    if (approval.choice !== "once") return { action: "forward" };
    const check = humanChoiceStillAllowed(permissionGate(approval.gate, approval.choices), policyOf(row, context.planOnly === true));
    return check.allowed ? { action: "forward" } : { action: "deny", reason: check.reason };
  }
  if (Number(row.revision) === Number(approval.revisionSeen)) return { action: "forward" };
  return { action: "redecide", resolution: decideV2(row, approval.gate, approval.choices, context) };
}
