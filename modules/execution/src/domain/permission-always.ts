/**
 * PERM2-4: which "Always" a human may answer a gate with.
 *
 *   always_bot_tool          a grant for this tool on this bot (plugin gate)
 *   always_runtime_terminal  the runtime switch for dangerous commands (D-3)
 *
 * Offered only when the pre-approval it records would answer THIS gate by
 * itself: the pipeline is asked, under an `auto` bot with no tool policy,
 * whether the grant or the switch is what says `once`. So a gate the
 * interdictions, the floor, an opaque operation or a deletion hold is never
 * offered an "Always" that would not cover it (spec section 5, step 4), and
 * an MCP tool, whose host cannot prove `deletes = no`, never is either.
 *
 * Nor under a mode where the pipeline never reads it: in `manual` (and
 * `plan`) every gate goes to a person before the grant stage (spec section 5,
 * step 5), so an "Always" clicked there would change nothing and the next
 * gate would ask again (lab, 2026-10-25). The mode is the one the gate was
 * decided under (`decision_detail.effectiveMode`); a gate without it is
 * offered none.
 *
 * Hermes still receives `once`: the "Always" lives in openedbot only.
 */

import { decidePermission, type PermissionGate, type PermissionModeId, type PermissionPolicy } from "./permission-decision";

export type AlwaysChoice = "always_bot_tool" | "always_runtime_terminal";
export const ALWAYS_CHOICES: readonly AlwaysChoice[] = ["always_bot_tool", "always_runtime_terminal"];

export function isAlwaysChoice(value: unknown): value is AlwaysChoice {
  return typeof value === "string" && (ALWAYS_CHOICES as readonly string[]).includes(value);
}

const PROBE: Omit<PermissionPolicy, "grantActive" | "terminalAlways"> = {
  mode: "auto",
  ceiling: null,
  enforceReview: false,
  reviewProven: true,
  toolPolicy: null,
  commandBlocklist: [],
};

/** The modes under which the pipeline reads a grant or the terminal switch. */
const MODES_READING_ALWAYS: ReadonlySet<string> = new Set<PermissionModeId>(["auto", "bypass"]);

/** The "Always" this gate may be answered with, or `null`. */
export function alwaysChoiceFor(gate: PermissionGate, effectiveMode: string | null): AlwaysChoice | null {
  if (!effectiveMode || !MODES_READING_ALWAYS.has(effectiveMode)) return null;
  if (gate.kind === "plugin_tool") {
    const decision = decidePermission(gate, { ...PROBE, grantActive: true, terminalAlways: false });
    return decision.outcome === "once" && decision.reason === "grant" ? "always_bot_tool" : null;
  }
  if (gate.kind === "terminal_danger") {
    const decision = decidePermission(gate, { ...PROBE, grantActive: false, terminalAlways: true });
    return decision.outcome === "once" && decision.reason === "terminal_switch" ? "always_runtime_terminal" : null;
  }
  return null;
}
