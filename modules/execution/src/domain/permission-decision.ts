/**
 * PERM2-1 (DEV-OHB-251): the permission pipeline of US-PERM2, section 5.
 * A pure function: one identified gate (PERM2-A) and the effective policy at
 * its revision in, one outcome out. Interdictions first, the floor next, the
 * intersection of rights last: no right of one tier lifts a restriction of
 * another, and no stage here is a model's judgement.
 *
 *   1. forbidden -> deny     "Block", plan + a plugin write, a forbidden tool,
 *                            the organization's command blocklist on a
 *                            terminal gate (an unreadable command is refused
 *                            whenever a list exists)
 *   2. yolo      -> deny     under an active YOLO lease only (and where
 *                 | once     `bypass` would be allowed, outside plan): the
 *                            hardline list, the lease's deny-list and its
 *                            protections refuse; anything else is approved.
 *                            What cannot be identified falls to the floor.
 *   3. floor     -> human    unidentified gate, a sensitive path the
 *                            descriptor names, the terminal circuit breaker,
 *                            no `once` choice, in every mode
 *   4. effective mode        min(bot mode, ceiling); enforce_review turns
 *                            bypass into auto; no proven review profile turns
 *                            auto into manual; plan stays plan
 *                            (`effectivePermissionMode` names the rule that
 *                            lowered it, as `effectiveBotPermission` does)
 *   5. opaque, deletion      human outside bypass (D-8)
 *   6. paths                 Ask / manual -> human; auto -> Always, grant or
 *                            terminal switch -> once, else review; bypass ->
 *                            once
 *
 * A tool policy that is absent or `inherit` follows the mode; a STORED value
 * this code does not know asks (iso Grok Bot: unknown -> needs approval).
 */

import { yoloPolicyBlock, type EffectivePermissionReason } from "@openedbot/contracts-api";
import type { YoloLeaseDenyList } from "@openedbot/contracts-connector";
import { commandDeletes, commandHitsCircuitBreaker, isSensitivePath } from "@openedbot/roster/domain/editor-directives";
import { commandMatchesBlocklist } from "./command-blocklist";
import type { GateDescriptor, GateKind } from "./gate-identity";
import { yoloDenyListHit, yoloHardlineHit, yoloProtectionHit, type YoloGateSubject } from "./yolo-hardline";

export { commandMatchesBlocklist } from "./command-blocklist";

export type PermissionModeId = "manual" | "plan" | "auto" | "bypass";
export type PermissionCeiling = "manual" | "auto" | "bypass";
export type PermissionOutcome = "deny" | "human" | "once" | "review";
export type DecisionStage = "forbidden" | "yolo" | "floor" | "opaque" | "deletion" | "tool_policy" | "grant" | "review" | "full" | "human" | "unattended";

export type PermissionGate = {
  kind: GateKind;
  toolKey: string | null;
  /** The plugin descriptor of a `plugin_tool` gate. */
  descriptor: GateDescriptor | null;
  /** The masked command of a `terminal_danger` gate; `null` when too long to keep. */
  command: string | null;
  choices: readonly string[];
};

export type PermissionPolicy = {
  /** The bot's stored mode; anything unknown is `manual`. */
  mode: string | null;
  ceiling: PermissionCeiling | null;
  enforceReview: boolean;
  /** PERM2-7a: the runtime's review profile is proven tool-less. */
  reviewProven: boolean;
  /** The stored per-tool policy (PERM2-5); `null` when none is stored. */
  toolPolicy: string | null;
  /** An active "Always for this tool on this bot" grant (PERM2-4). */
  grantActive: boolean;
  /** The runtime switch "dangerous commands: always allow" (PERM2-4, D-3). */
  terminalAlways: boolean;
  /** Command prefixes the organization refuses (PERM2-8). */
  commandBlocklist: readonly string[];
  /**
   * An ACTIVE YOLO lease that covers this gate's bot: already verified
   * (signature, runtime, time window) by `yolo-lease.ts`. Absent or `null`:
   * none, the pipeline is the one without YOLO.
   */
  yolo?: YoloGatePolicy | null;
};

/** What the pipeline reads of a lease: who to name, and what it never approves. */
export type YoloGatePolicy = { leaseId: string; deny: YoloLeaseDenyList; protect: readonly string[] };

export type PermissionDecision = {
  outcome: PermissionOutcome;
  stage: DecisionStage;
  /** A stable code for logs and `decision_detail`, never a gate argument. */
  reason: string;
  effectiveMode: PermissionModeId;
  /** The YOLO lease that answered (stage `yolo`). */
  yoloLeaseId?: string;
  /** PERM2-9: the stage and reason that held the gate for a person nobody is. */
  heldBy?: { stage: DecisionStage; reason: string };
};

/** Step 4: the effective mode, and why it is below the stored one (`null`: it is not). */
export type EffectivePermissionMode = { mode: PermissionModeId; reason: EffectivePermissionReason | null };

const MODE_RANK: Record<PermissionCeiling, number> = { manual: 0, auto: 1, bypass: 2 };
/** Tools of a toolset no policy may open (`ALWAYS_FORBIDDEN_TOOLSETS`). */
const FORBIDDEN_TOOLS: ReadonlySet<string> = new Set(["cronjob"]);
const TOOL_POLICIES: ReadonlySet<string> = new Set(["inherit", "always", "ask", "block"]);

function storedMode(mode: string | null): PermissionModeId {
  return mode === "plan" || mode === "auto" || mode === "bypass" ? mode : "manual";
}

/**
 * Step 4 alone: what the bot's mode is worth under its organization today,
 * and which rule brought it down. The last rule that applied names it, as
 * `effectiveBotPermission` does for the console (a test keeps both in line).
 */
export function effectivePermissionMode(policy: Pick<PermissionPolicy, "mode" | "ceiling" | "enforceReview" | "reviewProven">): EffectivePermissionMode {
  const mode = storedMode(policy.mode);
  if (mode === "plan") return { mode, reason: null };
  let effective: PermissionCeiling = mode;
  let reason: EffectivePermissionReason | null = null;
  if (policy.ceiling && MODE_RANK[policy.ceiling] < MODE_RANK[effective]) {
    effective = policy.ceiling;
    reason = "ceiling";
  }
  if (effective === "bypass" && policy.enforceReview) {
    effective = "auto";
    reason = "enforce_review";
  }
  if (effective === "auto" && !policy.reviewProven) {
    effective = "manual";
    reason = "review_unproven";
  }
  return effective === mode ? { mode, reason: null } : { mode: effective, reason };
}

/** A stored value outside the closed set asks; absent and `inherit` follow the mode. */
function toolPolicyOf(gate: PermissionGate, policy: PermissionPolicy): "inherit" | "always" | "ask" | "block" {
  if (gate.kind !== "plugin_tool" || policy.toolPolicy === null) return "inherit";
  return TOOL_POLICIES.has(policy.toolPolicy) ? policy.toolPolicy as "inherit" | "always" | "ask" | "block" : "ask";
}

function descriptorPaths(descriptor: GateDescriptor | null): string[] {
  const args = descriptor?.args ?? {};
  const paths = [args.path, ...(Array.isArray(args.paths) ? args.paths : [])];
  return paths.filter((path): path is string => typeof path === "string");
}

function forbidden(gate: PermissionGate, policy: PermissionPolicy, toolPolicy: string): string | null {
  if (toolPolicy === "block") return "tool_blocked";
  if (gate.kind === "plugin_tool" && storedMode(policy.mode) === "plan") return "plan_write";
  if (gate.toolKey && FORBIDDEN_TOOLS.has(gate.toolKey)) return "tool_forbidden";
  if (gate.kind === "terminal_danger" && policy.commandBlocklist.length > 0) {
    if (gate.command === null) return "command_unreadable";
    const matched = commandMatchesBlocklist(gate.command, policy.commandBlocklist);
    if (matched !== false) return matched === null ? "command_unreadable" : "command_blocklisted";
  }
  return null;
}

/**
 * Step 2, under an active lease. A gate the host could not identify, or
 * without a `once` choice, cannot be checked against the hardline list: it is
 * left to the floor (`null`), never approved blind. A lease is honored only
 * where `bypass` would be (the API refuses it elsewhere; a policy tightened
 * since then wins until the lease is revoked), and never in plan.
 */
function yoloStage(gate: PermissionGate, policy: PermissionPolicy, mode: PermissionModeId): [PermissionOutcome, string] | null {
  const yolo = policy.yolo;
  if (!yolo || mode === "plan" || yoloPolicyBlock({ maxMode: policy.ceiling, enforceReview: policy.enforceReview })) return null;
  if (gate.kind === "unknown" || !gate.choices.includes("once")) return null;
  if (gate.kind === "plugin_tool" && (!gate.descriptor || !gate.toolKey)) return null;
  if (gate.kind === "terminal_danger" && gate.command === null) return null;
  const subject: YoloGateSubject = {
    toolKey: gate.toolKey,
    paths: descriptorPaths(gate.descriptor),
    command: gate.kind === "terminal_danger" ? gate.command : null,
  };
  if (yoloHardlineHit(subject)) return ["deny", "yolo_hardline"];
  const denied = yoloDenyListHit(subject, yolo.deny);
  if (denied !== false) return ["deny", denied === null ? "command_unreadable" : "yolo_denied"];
  if (yoloProtectionHit(subject, yolo.protect)) return ["deny", "yolo_protected"];
  return ["once", "yolo_lease"];
}

function floor(gate: PermissionGate): string | null {
  if (gate.kind === "unknown") return "gate_unidentified";
  if (gate.kind === "plugin_tool" && (!gate.descriptor || !gate.toolKey)) return "descriptor_missing";
  if (descriptorPaths(gate.descriptor).some(isSensitivePath)) return "sensitive_path";
  if (gate.kind === "terminal_danger") {
    if (gate.command === null) return "command_unreadable";
    if (commandHitsCircuitBreaker(gate.command)) return "circuit_breaker";
  }
  if (!gate.choices.includes("once")) return "no_once_choice";
  return null;
}

function deletes(gate: PermissionGate): boolean {
  if (gate.kind === "terminal_danger") return gate.command === null || commandDeletes(gate.command);
  // `unknown` counts as a deletion: the host could not say it is not one.
  return gate.descriptor?.deletes !== "no";
}

export function decidePermission(gate: PermissionGate, policy: PermissionPolicy): PermissionDecision {
  const toolPolicy = toolPolicyOf(gate, policy);
  // The decision keeps its stored shape (worker golden); the downgrade
  // reason is read from `effectivePermissionMode` where it is shown.
  const effectiveMode = effectivePermissionMode(policy).mode;
  const decide = (outcome: PermissionOutcome, stage: DecisionStage, reason: string): PermissionDecision =>
    ({ outcome, stage, reason, effectiveMode });

  const refused = forbidden(gate, policy, toolPolicy);
  if (refused) return decide("deny", "forbidden", refused);
  const yolo = yoloStage(gate, policy, effectiveMode);
  if (yolo) return { ...decide(yolo[0], "yolo", yolo[1]), yoloLeaseId: policy.yolo!.leaseId };
  const held = floor(gate);
  if (held) return decide("human", "floor", held);
  if (effectiveMode === "plan") return decide("human", "human", "plan_mode");

  const bypass = effectiveMode === "bypass";
  if (gate.descriptor?.opaque && !bypass) return decide("human", "opaque", "opaque_operation");
  if (deletes(gate) && !bypass) return decide("human", "deletion", "deletion");

  if (toolPolicy === "ask") return decide("human", "tool_policy", "tool_ask");
  if (effectiveMode === "manual") return decide("human", "human", "manual_mode");
  const preApproval: [DecisionStage, string] | null = toolPolicy === "always" ? ["tool_policy", "tool_always"]
    : gate.kind === "plugin_tool" && policy.grantActive ? ["grant", "grant"]
      : gate.kind === "terminal_danger" && policy.terminalAlways ? ["grant", "terminal_switch"]
        : null;
  if (effectiveMode === "auto") {
    // Under enforce_review the reviewer sees every gate; pre-approvals are
    // handed to it as context and it may still escalate.
    if (policy.enforceReview) return decide("review", "review", "review_enforced");
    return preApproval ? decide("once", ...preApproval) : decide("review", "review", "review");
  }
  return preApproval ? decide("once", ...preApproval) : decide("once", "full", "full_access");
}

/**
 * A human `once` is re-checked against step 1 only before it is forwarded:
 * an interdiction set in the meantime turns it into `deny`. The floor never
 * undoes it (the human IS the floor's answer), nor does the rest.
 */
export function humanChoiceStillAllowed(gate: PermissionGate, policy: PermissionPolicy): { allowed: true } | { allowed: false; reason: string } {
  const refused = forbidden(gate, policy, toolPolicyOf(gate, policy));
  return refused ? { allowed: false, reason: refused } : { allowed: true };
}

/**
 * PERM2-9: a run nobody attends (a routine with "Never wait"). A gate the
 * pipeline would leave to a person is refused at once, and says which stage
 * held it (iso hermes-agent `approvals.cron_mode: deny`). It only ever turns
 * `human` into `deny`: an interdiction stays an interdiction, a policy answer
 * stays what it was, and a gate under review stays under review (the
 * reviewer refuses instead of escalating, `approval-review.ts`). An
 * unattended run never widens what a person would allow.
 */
export function unattendedDecision(decision: PermissionDecision, neverWait: boolean): PermissionDecision {
  if (!neverWait || decision.outcome !== "human") return decision;
  return {
    outcome: "deny",
    stage: "unattended",
    reason: "never_wait",
    effectiveMode: decision.effectiveMode,
    heldBy: { stage: decision.stage, reason: decision.reason },
  };
}
