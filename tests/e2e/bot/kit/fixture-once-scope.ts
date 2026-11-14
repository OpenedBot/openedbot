import type { BotDto, RuntimeIntegrationMcpServerDto } from '@openedbot/contracts-api';
import { labMcpNames, parseLabMcpEvidence, type LabMcpEvidence, type LabMcpTarget } from './lab-mcp-contract';
import type { McpFixture } from './p1-mcp-fixture';

export type FixtureOnceScope =
  | { kind: 'skill-create'; name: string }
  | { kind: 'lab-mcp-read'; target: LabMcpTarget; receipt: LabMcpEvidence; challenge: string }
  | { kind: 'https-mcp-read'; serverName: string; registration: RuntimeIntegrationMcpServerDto; fixture: McpFixture; origin: string; challenge: string };
export type FixtureGate = {
  id: string; organizationId: string; botId: string | null; threadId: string; runId: string;
  hermesRequestId: string | null; gateKind: string; toolKey: string | null;
  descriptorVersion: number | null; gateArgs: unknown;
  status: string; forwardState: string; selectedChoice: string | null; decisionState: string | null;
};
export type FixtureGateBinding = { organizationId: string; botId: string; threadId: string; runId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fail(message: string): never { throw new Error(`Fixture once approval refused: ${message}`); }
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

/** Validate the independently owned fixture before dispatching any model turn. */
export function requireFixtureOnceScope(scope: FixtureOnceScope, bot: Pick<BotDto, 'id' | 'hermesProfile' | 'hermesProfileManaged'>, runtimeId: string): void {
  if (!bot.hermesProfile || !bot.hermesProfileManaged) fail('a managed disposable bot profile is required.');
  if (scope.kind === 'skill-create') {
    if (!/^e2e-[a-z0-9][a-z0-9-]{0,122}$/.test(scope.name)) fail('the exact fresh e2e- skill name is required.');
    return;
  }
  if (!UUID.test(scope.challenge)) fail('the exact fresh MCP challenge must be a canonical UUID.');
  if (scope.kind === 'lab-mcp-read') {
    if (scope.target.profile !== bot.hermesProfile || scope.target.runtimeId !== runtimeId) fail('the native MCP fixture belongs to another profile/runtime.');
    const receipt = parseLabMcpEvidence(JSON.stringify(scope.receipt), scope.target, 'receipts');
    if (!receipt.installed || receipt.removed) fail('the native read-only fixture is not installed and owned.');
    return;
  }
  if (!/^e2e_[A-Za-z0-9_-]{1,36}$/.test(scope.serverName)) fail('the generated HTTPS fixture server name is invalid.');
  const url = scope.fixture.url(scope.origin);
  if (!UUID.test(scope.fixture.namespace) || scope.registration.name !== scope.serverName
    || scope.registration.transport !== 'http' || scope.registration.auth !== 'none'
    || scope.registration.endpoint !== url || !scope.registration.discoveredTools?.includes('read_probe')) {
    fail('the HTTPS read-only fixture registration is not the exact controlled server.');
  }
}

/** Closed diagnostic fields only: never arguments, descriptors or request values. */
export function fixtureGateDiagnostic(gate: Pick<FixtureGate, 'gateKind' | 'descriptorVersion' | 'hermesRequestId' | 'toolKey'>, scope: FixtureOnceScope) {
  const kind = ['plugin_tool', 'terminal_danger', 'unknown'].includes(gate.gateKind) ? gate.gateKind : 'invalid';
  const rawVersion = gate.descriptorVersion;
  const version = rawVersion === null ? null
    : typeof rawVersion === 'number' && Number.isSafeInteger(rawVersion) && rawVersion >= 0 && rawVersion <= 65_535 ? rawVersion : 'invalid';
  let tool: string | null = gate.toolKey === null ? null : 'other';
  if (['write_file', 'patch', 'skill_manage', 'execute_code', 'send_message', 'cronjob'].includes(gate.toolKey ?? '')) tool = gate.toolKey;
  if (scope.kind !== 'skill-create') {
    const server = scope.kind === 'lab-mcp-read' ? labMcpNames(scope.target).serverName : scope.serverName;
    if (gate.toolKey === `mcp:${server}:read_probe`) tool = 'mcp:owned:read_probe';
  }
  return { kind, version, hasRequest: typeof gate.hermesRequestId === 'string' && gate.hermesRequestId.trim().length > 0, tool };
}

/** Only this run's identified create/read gate is authorized; opaque arbitrary actions are never accepted. */
export function requireFixtureGate(gate: FixtureGate, binding: FixtureGateBinding, scope: FixtureOnceScope): void {
  function refuse(message: string): never { fail(`${message} Diagnostic ${JSON.stringify(fixtureGateDiagnostic(gate, scope))}`); }
  if (gate.organizationId !== binding.organizationId || gate.botId !== binding.botId || gate.threadId !== binding.threadId || gate.runId !== binding.runId) {
    refuse('gate organization/bot/thread/run binding differs.');
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(gate.id) || !gate.hermesRequestId?.trim() || gate.hermesRequestId.length > 256
    || gate.gateKind !== 'plugin_tool' || gate.descriptorVersion !== 1) {
    refuse('the gate lacks a version 1 plugin identity and Hermes request id.');
  }
  const descriptor = record(gate.gateArgs);
  const args = record(descriptor?.args);
  if (!descriptor || !args || !exactKeys(descriptor, ['tool', 'deletes', 'opaque', 'digest', 'args'])
    || descriptor.tool !== gate.toolKey || typeof descriptor.opaque !== 'boolean'
    || typeof descriptor.digest !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.digest)) refuse('the identified descriptor is malformed.');
  if (scope.kind === 'skill-create') {
    if (gate.toolKey !== 'skill_manage' || descriptor.deletes !== 'no' || descriptor.opaque !== false
      || !exactKeys(args, ['action', 'name']) || args.action !== 'create' || args.name !== scope.name) {
      refuse('only creation of the exact owned skill may receive once.');
    }
    return;
  }
  const server = scope.kind === 'lab-mcp-read' ? labMcpNames(scope.target).serverName : scope.serverName;
  const arguments_ = record(args.arguments);
  if (gate.toolKey !== `mcp:${server}:read_probe` || !['no', 'unknown'].includes(String(descriptor.deletes))
    || !exactKeys(args, ['server', 'tool', 'arguments']) || args.server !== server || args.tool !== 'read_probe'
    || !arguments_ || !exactKeys(arguments_, ['challenge']) || arguments_.challenge !== scope.challenge) {
    refuse('only the fixed owned MCP read_probe with this exact challenge may receive once.');
  }
}
