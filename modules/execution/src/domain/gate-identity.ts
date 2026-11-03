/**
 * PERM2-A: the identity of one Hermes approval gate, read on the RAW
 * `approval.request` event, before `sanitizeToolErrorMessage` touches it.
 *
 * Hermes sends `request_id` (the gate to answer), `pattern_key` (what the
 * gate is) and `description`. The openedbot host plugin answers `rule_key =
 * "ohb/v1/<tool_key>"`, which Hermes turns into `pattern_key =
 * "plugin_rule:ohb/v1/<tool_key>"`, and ends its message with one descriptor
 * line: `ohb-gate/v1 <sha256 of the JSON text> <JSON>`. The digest proves the
 * line reached us whole: Hermes redacts the description before egress, and a
 * redaction or a truncation that touched the descriptor turns the gate into
 * `unknown`, never into a partly trusted one.
 *
 * Terminal gates carry the description of the dangerous pattern as their
 * `pattern_key` (`tools/approval_detection.py`, `detect_dangerous_command`).
 * Any other gate (another plugin, the native `execute_code` gate, a malformed
 * key) is `unknown`: the permission pipeline sends it to a human.
 *
 * The host capability `approval_policy.gate_identity` is checked by the
 * pipeline, not here: this reader only says what the event claims.
 */

import { createHash } from "node:crypto";
import { redactSecrets } from "./tool-text";

export type GateKind = "plugin_tool" | "terminal_danger" | "unknown";
export type GateDeletes = "yes" | "no" | "unknown";

/** The descriptor the host plugin computed from the full tool arguments. */
export type GateDescriptor = {
  tool: string;
  deletes: GateDeletes;
  opaque: boolean;
  /** SHA-256 of the full arguments, so two gates can be compared without them. */
  digest: string;
  args: Record<string, unknown>;
};

export type GateIdentity = {
  hermesRequestId: string | null;
  gateKind: GateKind;
  /** Set only for a `plugin_tool` gate whose descriptor was proven. */
  toolKey: string | null;
  /** The plugin descriptor, or `{ command }` for a terminal gate. */
  gateArgs: Record<string, unknown> | null;
  descriptorVersion: number | null;
};

export const GATE_DESCRIPTOR_VERSION = 1;
export const GATE_DESCRIPTOR_MAX_BYTES = 1024;
/** Upstream bound on `request_id` (`api_server_runs.py`, approval route). */
export const GATE_REQUEST_ID_MAX_CHARS = 256;
export const GATE_COMMAND_MAX_CHARS = 2000;
const PATTERN_KEY_MAX_CHARS = 200;

const PLUGIN_RULE_PREFIX = "plugin_rule:";
const OPENEDBOT_RULE_PREFIX = `${PLUGIN_RULE_PREFIX}ohb/v1/`;
const DESCRIPTOR_LINE = /^ohb-gate\/v1 ([0-9a-f]{64}) (\{.*\})$/;
const DESCRIPTOR_PREFIX = "ohb-gate/";
const NATIVE_TOOL_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const MCP_TOOL_KEY = /^mcp:([A-Za-z0-9_.-]{1,64}):([A-Za-z0-9_.-]{1,128})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const DELETES: readonly GateDeletes[] = ["yes", "no", "unknown"];
const PATH_MAX_CHARS = 512;

type ArgsCheck = (args: Record<string, unknown>, descriptor: GateDescriptor) => boolean;

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const size = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
const onlyKeys = (args: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(args).every((key) => keys.includes(key));

/**
 * The closed table of spec §6, twin of `approval_policy_plugin/__init__.py`.
 * A tool absent from it is not a gate the plugin raises: `unknown`.
 */
const NATIVE_DESCRIPTORS: Record<string, ArgsCheck> = {
  write_file: (args, d) => onlyKeys(args, ["path", "size"]) && boundedString(args.path, PATH_MAX_CHARS) && size(args.size) && d.deletes !== "unknown",
  patch: (args) => onlyKeys(args, ["paths", "ops"])
    && Array.isArray(args.paths) && args.paths.length <= 16 && args.paths.every((path) => boundedString(path, PATH_MAX_CHARS))
    && Array.isArray(args.ops) && args.ops.length <= 16 && args.ops.every((op) => ["add", "update", "delete", "move", "replace"].includes(op as string)),
  skill_manage: (args, d) => onlyKeys(args, ["action", "name"]) && boundedString(args.action, 32) && (args.name === undefined || boundedString(args.name, 128))
    && (args.action === "delete") === (d.deletes === "yes"),
  send_message: (args, d) => onlyKeys(args, ["action", "platform", "target"]) && boundedString(args.action, 32)
    && (args.target === undefined ? args.platform === undefined : boundedString(args.target, 256) && boundedString(args.platform, 32))
    && d.deletes === "no",
  cronjob: (args) => onlyKeys(args, []),
  execute_code: (args, d) => onlyKeys(args, ["language", "size"]) && boundedString(args.language, 32) && size(args.size) && d.opaque,
};

const mcpDescriptor: ArgsCheck = (args, d) =>
  onlyKeys(args, ["server", "tool", "arguments"]) && boundedString(args.server, 64) && boundedString(args.tool, 128)
  // Hermes keeps no `destructiveHint` of an MCP tool (only `readOnlyHint`,
  // `tools/mcp_tool.py`): the plugin cannot prove `no`, so it never claims it.
  && d.deletes === "unknown"
  && (args.arguments !== undefined || d.opaque);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requestId(raw: Record<string, unknown>): string | null {
  const value = typeof raw.request_id === "string" ? raw.request_id.trim() : "";
  return value && value.length <= GATE_REQUEST_ID_MAX_CHARS ? value : null;
}

function descriptorLine(description: unknown): string | null {
  if (typeof description !== "string") return null;
  const lines = description.split("\n").filter((line) => line.startsWith(DESCRIPTOR_PREFIX));
  // Two descriptor lines are a forgery or a defect: neither is trusted.
  return lines.length === 1 ? lines[0]! : null;
}

function parseDescriptor(line: string | null, toolKey: string): GateDescriptor | null {
  const match = line ? DESCRIPTOR_LINE.exec(line) : null;
  if (!match) return null;
  const [, digest, text] = match as unknown as [string, string, string];
  if (Buffer.byteLength(text, "utf8") > GATE_DESCRIPTOR_MAX_BYTES) return null;
  if (createHash("sha256").update(text, "utf8").digest("hex") !== digest) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const body = record(parsed);
  const args = record(body?.args);
  if (!body || !args || !onlyKeys(body, ["v", "tool", "deletes", "opaque", "digest", "args"])) return null;
  if (body.v !== GATE_DESCRIPTOR_VERSION || body.tool !== toolKey) return null;
  if (!DELETES.includes(body.deletes as GateDeletes) || typeof body.opaque !== "boolean") return null;
  if (typeof body.digest !== "string" || !DIGEST.test(body.digest)) return null;
  const descriptor: GateDescriptor = { tool: toolKey, deletes: body.deletes as GateDeletes, opaque: body.opaque, digest: body.digest, args };
  const check = MCP_TOOL_KEY.test(toolKey) ? mcpDescriptor : NATIVE_DESCRIPTORS[toolKey];
  return check?.(args, descriptor) ? descriptor : null;
}

function terminalPatternKey(raw: Record<string, unknown>): string | null {
  const key = typeof raw.pattern_key === "string" ? raw.pattern_key : "";
  if (!key || key.length > PATTERN_KEY_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(key)) return null;
  if (key.startsWith(PLUGIN_RULE_PREFIX) || key === "execute_code") return null;
  // A terminal gate names one pattern; a list that disagrees is not one.
  const keys = raw.pattern_keys;
  if (keys !== undefined && !(Array.isArray(keys) && keys.length > 0 && keys.every((entry) => entry === key))) return null;
  return key;
}

const UNKNOWN = { gateKind: "unknown", toolKey: null, gateArgs: null, descriptorVersion: null } as const;

export function readGateIdentity(raw: Record<string, unknown>): GateIdentity {
  const hermesRequestId = requestId(raw);
  const patternKey = typeof raw.pattern_key === "string" ? raw.pattern_key : "";
  if (patternKey.startsWith(OPENEDBOT_RULE_PREFIX)) {
    const toolKey = patternKey.slice(OPENEDBOT_RULE_PREFIX.length);
    if (!NATIVE_TOOL_KEY.test(toolKey) && !MCP_TOOL_KEY.test(toolKey)) return { hermesRequestId, ...UNKNOWN };
    const descriptor = parseDescriptor(descriptorLine(raw.description), toolKey);
    if (!descriptor) return { hermesRequestId, ...UNKNOWN };
    return { hermesRequestId, gateKind: "plugin_tool", toolKey, gateArgs: descriptor, descriptorVersion: GATE_DESCRIPTOR_VERSION };
  }
  if (terminalPatternKey(raw) !== null) {
    // Masked like every displayed command, never truncated: a blocklist must
    // match the whole command. One too long to keep stays `null`, which a
    // blocklist refuses.
    const command = typeof raw.command === "string" && raw.command.length <= GATE_COMMAND_MAX_CHARS ? redactSecrets(raw.command) : null;
    return { hermesRequestId, gateKind: "terminal_danger", toolKey: null, gateArgs: { patternKey, command }, descriptorVersion: null };
  }
  return { hermesRequestId, ...UNKNOWN };
}

/** The plugin sentence a human reads: the descriptor line is machine data. */
export function gateDescriptionText(description: unknown): unknown {
  if (typeof description !== "string") return description;
  return description.split("\n").filter((line) => !line.startsWith(DESCRIPTOR_PREFIX)).join("\n").trim();
}
