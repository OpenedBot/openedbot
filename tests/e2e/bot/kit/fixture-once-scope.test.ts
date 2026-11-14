import { describe, expect, test } from 'bun:test';
import type { RuntimeIntegrationMcpServerDto } from '@openedbot/contracts-api';
import { requireFixtureGate, requireFixtureOnceScope, type FixtureGate, type FixtureOnceScope } from './fixture-once-scope';
import { labMcpNames, type LabMcpEvidence } from './lab-mcp-contract';
import { McpFixture } from './p1-mcp-fixture';

const runtimeId = '750b6e7c-6fb3-4fbd-8d79-b4bb8451b69a';
const nonce = 'e91f2fdf-daab-49c7-9e61-f638fdaa3074';
const challenge = 'a92c46bf-8554-4a7a-a90d-920dff2e9916';
const bot = { id: 'bot', hermesProfile: 'e2e-owned', hermesProfileManaged: true };
const binding = { organizationId: 'organization', botId: bot.id, threadId: 'thread', runId: 'run' };
const skill: FixtureOnceScope = { kind: 'skill-create', name: 'e2e-probe-owned' };
const descriptor = { tool: 'skill_manage', deletes: 'no', opaque: false, digest: 'a'.repeat(64), args: { action: 'create', name: skill.name } };
const gate: FixtureGate = { id: 'approval', ...binding, hermesRequestId: 'hermes-request', gateKind: 'plugin_tool', toolKey: 'skill_manage',
  descriptorVersion: 1, gateArgs: descriptor, status: 'pending', forwardState: 'pending', selectedChoice: null, decisionState: 'awaiting_human' };
const target = { runtimeId, nonce, profile: bot.hermesProfile };
const receipt: LabMcpEvidence = { schemaVersion: 1, kind: 'mcp-fixture', action: 'receipts', ...target, ...labMcpNames(target),
  installed: true, removed: false, replayed: false, online: true, calls: [], processes: [], starts: 0 };

describe('fixture once gate scope', () => {
  test('the managed fresh skill create descriptor is the only allowed skill action', () => {
    expect(() => requireFixtureOnceScope(skill, bot, runtimeId)).not.toThrow();
    expect(() => requireFixtureGate(gate, binding, skill)).not.toThrow();
    for (const patch of [{ action: 'delete' }, { action: 'update' }, { name: 'operator' }, { name: '../operator' }, { action: 'create', path: '/tmp/foreign' }]) {
      expect(() => requireFixtureGate({ ...gate, gateArgs: { ...descriptor, args: { ...descriptor.args, ...patch } } }, binding, skill)).toThrow('exact owned skill');
    }
    for (const name of ['operator', 'e2e-../foreign', 'e2e-a/name']) expect(() => requireFixtureOnceScope({ kind: 'skill-create', name }, bot, runtimeId)).toThrow();
    expect(() => requireFixtureOnceScope(skill, { ...bot, hermesProfileManaged: false }, runtimeId)).toThrow('managed');
  });

  test('cross-tenant/bot/thread/run gates and malformed plugin identities never receive once', () => {
    for (const patch of [{ organizationId: 'foreign' }, { botId: 'foreign' }, { threadId: 'foreign' }, { runId: 'foreign' },
      { gateKind: 'unknown' }, { toolKey: 'execute_code' }, { hermesRequestId: null }, { hermesRequestId: ' ' },
      { descriptorVersion: null }, { descriptorVersion: 2 }, { id: '../approval' }]) {
      expect(() => requireFixtureGate({ ...gate, ...patch }, binding, skill)).toThrow('refused');
    }
    for (const patch of [{ deletes: 'yes' }, { opaque: true }, { digest: 'invalid' }, { tool: 'terminal' }, { args: null }, { extra: true }]) {
      expect(() => requireFixtureGate({ ...gate, gateArgs: { ...descriptor, ...patch } }, binding, skill)).toThrow('refused');
    }
  });

  test('opaque MCP approval is limited to the receipt-owned read_probe and exact fresh challenge', () => {
    const scope: FixtureOnceScope = { kind: 'lab-mcp-read', target, receipt, challenge };
    const mcpDescriptor = { tool: `mcp:${receipt.serverName}:read_probe`, deletes: 'unknown', opaque: true, digest: 'b'.repeat(64),
      args: { server: receipt.serverName, tool: 'read_probe', arguments: { challenge } } };
    const mcpGate = { ...gate, toolKey: mcpDescriptor.tool, gateArgs: mcpDescriptor };
    expect(() => requireFixtureOnceScope(scope, bot, runtimeId)).not.toThrow();
    expect(() => requireFixtureGate(mcpGate, binding, scope)).not.toThrow();
    for (const args of [{ ...mcpDescriptor.args, server: 'foreign' }, { ...mcpDescriptor.args, tool: 'delete' },
      { ...mcpDescriptor.args, arguments: {} }, { ...mcpDescriptor.args, arguments: { challenge: nonce } },
      { ...mcpDescriptor.args, arguments: { challenge, command: 'id' } }]) {
      expect(() => requireFixtureGate({ ...mcpGate, gateArgs: { ...mcpDescriptor, args } }, binding, scope)).toThrow('fixed owned MCP');
    }
    expect(() => requireFixtureGate({ ...mcpGate, gateArgs: { ...mcpDescriptor, deletes: 'yes' } }, binding, scope)).toThrow();
    expect(() => requireFixtureOnceScope({ ...scope, receipt: { ...receipt, profile: 'e2e-foreign' } }, bot, runtimeId)).toThrow();
    expect(() => requireFixtureOnceScope({ ...scope, target: { ...target, profile: 'e2e-foreign' } }, bot, runtimeId)).toThrow('another profile');
    expect(() => requireFixtureOnceScope({ ...scope, receipt: { ...receipt, installed: false, removed: true, online: false } }, bot, runtimeId)).toThrow('not installed');
    expect(() => requireFixtureOnceScope({ ...scope, challenge: 'guess' }, bot, runtimeId)).toThrow('canonical UUID');
  });

  test('HTTPS approval requires the exact trusted controlled fixture registration', () => {
    const fixture = new McpFixture(), origin = 'https://fixture.example', serverName = 'e2e_owned_probe';
    const registration: RuntimeIntegrationMcpServerDto = { name: serverName, transport: 'http', endpoint: fixture.url(origin), command: null,
      auth: 'none', configEnabled: true, platformEnabled: true, toolsIncluded: null, toolsExcluded: null, envKeys: [], discoveredTools: ['read_probe'], unreachable: false, oauthTokenPresent: null };
    const scope: FixtureOnceScope = { kind: 'https-mcp-read', serverName, registration, fixture, origin, challenge };
    expect(() => requireFixtureOnceScope(scope, bot, runtimeId)).not.toThrow();
    for (const patch of [{ name: 'foreign' }, { endpoint: 'https://foreign.example' }, { discoveredTools: [] }, { auth: 'oauth' as const }]) {
      expect(() => requireFixtureOnceScope({ ...scope, registration: { ...registration, ...patch } }, bot, runtimeId)).toThrow('exact controlled');
    }
    expect(() => requireFixtureOnceScope({ ...scope, origin: 'http://fixture.example' }, bot, runtimeId)).toThrow('HTTPS');
  });
});

describe('fixture approval diagnostics stay closed and redacted', () => {
  test('unknown identity reports only kind/version/request presence/tool class and still refuses', () => {
    const unknown = { ...gate, gateKind: 'unknown', descriptorVersion: null, toolKey: null, hermesRequestId: 'secret-request-never-print',
      gateArgs: { secret: 'secret-content-never-print' } };
    let message = '';
    try { requireFixtureGate(unknown, binding, skill); } catch (error) { message = String(error); }
    expect(message).toContain('"kind":"unknown","version":null,"hasRequest":true,"tool":null');
    expect(message).not.toContain('secret-request'); expect(message).not.toContain('secret-content');
  });
  test('untrusted labels and request values cannot enter diagnostics', () => {
    const hostile = { ...gate, gateKind: 'secret-kind-never-print', toolKey: 'secret-tool-never-print', descriptorVersion: null,
      hermesRequestId: 'secret-request-never-print', gateArgs: { secret: 'secret-args-never-print' } };
    let message = '';
    try { requireFixtureGate(hostile, binding, skill); } catch (error) { message = String(error); }
    expect(message).toContain('"kind":"invalid"'); expect(message).toContain('"tool":"other"');
    expect(message).not.toContain('never-print');
  });
});
