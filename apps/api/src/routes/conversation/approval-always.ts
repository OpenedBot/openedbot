import type { ApprovalAlwaysChoice } from "@openedbot/contracts-api";
import { alwaysChoiceFor } from "@openedbot/execution/domain/permission-always";
import { permissionGate } from "@openedbot/execution/application/runner/permission-gate";
import type { AuthContext } from "../identity/auth";

/**
 * PERM2-4: who may answer a gate with an "Always", and which one. The same
 * function feeds the thread DTO (`alwaysOffered`) and the answer route, which
 * computes it again at click time and refuses when it has fallen.
 *
 * V1 keeps the card's "Always" to a member owner or admin: the answer writes
 * `resolved_by` and the signed journal, both keyed to `memberships`
 * (0007), which an agency actor is not in. An agency sets a grant's
 * revocation or the runtime switch from the settings instead.
 */
export type AlwaysGateRow = {
  pipeline: string | null;
  decisionState: string | null;
  gateKind: string | null;
  toolKey: string | null;
  gateArgs: Record<string, unknown> | null;
  choices: unknown;
  /** `decision_detail.effectiveMode`: the bot's mode when the gate was decided. */
  effectiveMode: string | null;
};

export function mayAnswerAlways(auth: Pick<AuthContext, "role" | "actingFleetId">): boolean {
  return !auth.actingFleetId && (auth.role === "owner" || auth.role === "admin");
}

export function alwaysOffered(row: AlwaysGateRow, auth: Pick<AuthContext, "role" | "actingFleetId">): ApprovalAlwaysChoice | null {
  if (!mayAnswerAlways(auth)) return null;
  // A pipeline gate waiting for a human, in an organization still on `v2`.
  if (row.pipeline !== "v2" || row.decisionState !== "awaiting_human") return null;
  if (row.gateKind !== "plugin_tool" && row.gateKind !== "terminal_danger") return null;
  const gate = permissionGate(
    { hermesRequestId: null, gateKind: row.gateKind, toolKey: row.toolKey, gateArgs: row.gateArgs, descriptorVersion: null },
    Array.isArray(row.choices) ? row.choices : [],
  );
  return alwaysChoiceFor(gate, row.effectiveMode);
}

/** A stable code for `decision_detail.grantError`, never a database message. */
export function alwaysErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : "PERMISSION_GRANT_FAILED";
}

/**
 * The tool a gate asks about, as the card names it. A proven `plugin_tool`
 * gate carries the real tool (`write_file`, `execute_code`, `mcp:srv:tool`);
 * `shell` stays for a terminal gate and for a gate whose identity is unknown.
 */
export function approvalKind(gate: Pick<AlwaysGateRow, "gateKind" | "toolKey">): string {
  if (gate.gateKind !== "plugin_tool" || !gate.toolKey) return "shell";
  const mcp = /^mcp:([^:]+):(.+)$/.exec(gate.toolKey);
  return mcp ? `${mcp[2]} (${mcp[1]})` : gate.toolKey;
}

/**
 * What the card needs to phrase a proven plugin gate in its own language: the
 * tool key and the bounded descriptor arguments (`path`, `paths`, `ops`...),
 * already redacted by Hermes and proven by their digest. MCP `arguments`
 * (free-form values) and the digest never leave the API. Anything but a
 * proven `plugin_tool` gate exposes nothing: the card then keeps the raw text.
 */
export function approvalGateView(
  gate: Pick<AlwaysGateRow, "gateKind" | "toolKey" | "gateArgs">,
): { toolKey: string | null; gateArgs: Record<string, unknown> | null } {
  if (gate.gateKind !== "plugin_tool" || !gate.toolKey) return { toolKey: null, gateArgs: null };
  const args = gate.gateArgs?.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return { toolKey: gate.toolKey, gateArgs: null };
  const { arguments: _free, ...bounded } = args as Record<string, unknown>;
  return { toolKey: gate.toolKey, gateArgs: bounded };
}
