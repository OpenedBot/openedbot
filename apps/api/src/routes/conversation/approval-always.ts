import type { ApprovalAlwaysChoice, RoutineGateDto } from "@openedbot/contracts-api";
import type { Locale } from "@openedbot/contracts-locale";
import { alwaysChoiceFor } from "@openedbot/execution/domain/permission-always";
import { localeFormat } from "@openedbot/execution/domain/locale-format";
import { routineGateView, type RoutineGateTarget } from "@openedbot/execution/domain/routine-gate";
import { routineGateSentence } from "@openedbot/execution/domain/routine-gate-text";
import { ROUTINE_TOOL_KEY } from "@openedbot/execution/domain/routine-tool";
import { readRoutineGateTargets } from "@openedbot/execution/application/routine-tool-state";
import { permissionGate } from "@openedbot/execution/application/runner/permission-gate";
import type { TransactionDb } from "@openedbot/platform-db";
import type { AuthContext } from "../identity/auth";

/**
 * PERM2-4: who may answer a gate with an "Always", and which one. The same
 * function feeds the thread DTO (`alwaysOffered`) and the answer route, which
 * computes it again at click time and refuses when it has fallen.
 *
 * The card's "Always" is kept to an owner or an admin, who also hold the
 * settings where a grant is revoked and the runtime switch is turned off.
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

export function mayAnswerAlways(auth: Pick<AuthContext, "role">): boolean {
  return auth.role === "owner" || auth.role === "admin";
}

export function alwaysOffered(row: AlwaysGateRow, auth: Pick<AuthContext, "role">): ApprovalAlwaysChoice | null {
  if (!mayAnswerAlways(auth)) return null;
  // A pipeline gate waiting for a human, in an organization still on `v2`.
  if (row.pipeline !== "v2" || row.decisionState !== "awaiting_human") return null;
  if (row.gateKind !== "plugin_tool" && row.gateKind !== "terminal_danger") return null;
  const gate = permissionGate(
    { hermesRequestId: null, hermesExecutionGeneration: null, gateKind: row.gateKind, toolKey: row.toolKey, gateArgs: row.gateArgs, descriptorVersion: null },
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
 *
 * A `routine_manage` gate also carries what it is about to do (`routine`),
 * and its `detail` becomes that, in a sentence: every client shows `detail`,
 * one that cannot phrase the gate itself included (the phone). The host's
 * sentence said nothing more than the tool's name.
 */
export function approvalGateView(
  gate: Pick<AlwaysGateRow, "gateKind" | "toolKey" | "gateArgs"> & { botId?: string | null },
  routine?: RoutineGateContext,
): { toolKey: string | null; gateArgs: Record<string, unknown> | null; routine?: RoutineGateDto | null; detail?: string } {
  if (gate.gateKind !== "plugin_tool" || !gate.toolKey) return { toolKey: null, gateArgs: null };
  const args = gate.gateArgs?.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return { toolKey: gate.toolKey, gateArgs: null };
  const { arguments: free, ...bounded } = args as Record<string, unknown>;
  if (gate.toolKey !== ROUTINE_TOOL_KEY || !routine) return { toolKey: gate.toolKey, gateArgs: bounded };
  const target = routineTargetKey(gate.botId ?? null, free);
  const view = routineGateView(free, target ? routine.targets.get(target) ?? null : null, routine.now);
  // The server names no reader's zone: an instant the call gives without one reads in UTC, and says so.
  return { toolKey: gate.toolKey, gateArgs: bounded, routine: view, detail: routineGateSentence(view, localeFormat(routine.locale), "UTC") };
}

/** What a `routine_manage` gate is described with: the routines it names and the reader's language. */
export type RoutineGateContext = { targets: ReadonlyMap<string, RoutineGateTarget>; locale: Locale; now: Date };

function routineTargetKey(botId: string | null, free: unknown): string | null {
  const jobId = free && typeof free === "object" ? (free as Record<string, unknown>).job_id : null;
  return botId && typeof jobId === "string" ? `${botId}:${jobId.trim().toLowerCase()}` : null;
}

/**
 * The context to describe these gates' `routine_manage` calls. The language
 * is the request's (`Accept-Language`, as the login e-mails read it): the
 * product stores no language per user, and the console phrases the gate
 * again in its own from `routine`.
 */
export async function routineGateContext(
  tx: TransactionDb,
  organizationId: string,
  gates: ReadonlyArray<Pick<AlwaysGateRow, "gateKind" | "toolKey" | "gateArgs"> & { botId: string | null }>,
  acceptLanguage: string | undefined,
): Promise<RoutineGateContext> {
  const refs = gates.flatMap((gate) => {
    if (gate.gateKind !== "plugin_tool" || gate.toolKey !== ROUTINE_TOOL_KEY) return [];
    const free = (gate.gateArgs?.args as Record<string, unknown> | undefined)?.arguments;
    const jobId = free && typeof free === "object" ? (free as Record<string, unknown>).job_id : null;
    return typeof jobId === "string" ? [{ botId: gate.botId, jobId: jobId.trim() }] : [];
  });
  const targets = refs.length > 0 ? await readRoutineGateTargets(tx, organizationId, refs) : new Map<string, RoutineGateTarget>();
  return { targets, locale: acceptLanguage?.trim().toLowerCase().startsWith("en") ? "en" : "fr", now: new Date() };
}
