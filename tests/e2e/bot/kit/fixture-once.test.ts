import { describe, expect, test } from 'bun:test';
import type { BotDto } from '@openedbot/contracts-api';
import { sendFixtureOnce, sendFixtureWithoutApproval } from './fixture-once';
import type { FixtureGate } from './fixture-once-scope';
import type { ScenarioContext } from './scenario';

type Mode = 'normal' | 'no-gate' | 'foreign-run' | 'duplicate' | 'unexpected' | 'unconfirmed' | 'second' | 'changed' | 'api-error' | 'always';
function harness(mode: Mode = 'normal') {
  const bot = { id: 'bot', hermesProfile: 'e2e-owned', hermesProfileManaged: true } as BotDto;
  const binding = { organizationId: 'organization', botId: 'bot', threadId: 'thread', runId: 'run' };
  const descriptor = { tool: 'skill_manage', deletes: 'no', opaque: false, digest: 'a'.repeat(64), args: { action: 'create', name: 'e2e-probe-owned' } };
  const gate: FixtureGate = { ...binding, id: 'approval', hermesRequestId: 'request', gateKind: 'plugin_tool', toolKey: 'skill_manage',
    descriptorVersion: 1, gateArgs: descriptor, status: 'pending', forwardState: 'pending', selectedChoice: null, decisionState: 'awaiting_human' };
  let status = mode === 'no-gate' ? 'completed' : 'awaiting_approval';
  const gates = mode === 'no-gate' ? [] : [gate];
  if (mode === 'duplicate') gates.push({ ...gate, id: 'second-approval' });
  if (mode === 'unexpected') gate.gateArgs = { ...descriptor, args: { action: 'delete', name: descriptor.args.name } };
  const mutations: Array<{ path: string; body: unknown }> = [];
  const context = {
    config: { runTimeoutMs: 20 }, session: { organizationId: 'organization', runtime: { id: 'runtime' },
      async api(_method: string, path: string, body: unknown) {
        mutations.push({ path, body });
        if (path.endsWith('/messages')) return { runId: 'run' };
        if (path.endsWith('/cancel')) { status = 'cancelled'; return; }
        if (path.endsWith('/respond')) {
          if (mode === 'api-error') throw new Error('{"error":{"code":"APPROVAL_NOT_PENDING"}}');
          gate.status = 'approved'; gate.selectedChoice = 'once'; gate.forwardState = mode === 'unconfirmed' ? 'pending' : 'confirmed';
          status = mode === 'second' || mode === 'changed' ? 'awaiting_approval' : 'completed';
          if (mode === 'second') gates.push({ ...gate, id: 'second-approval', hermesRequestId: 'second-request' });
          if (mode === 'changed') gate.hermesRequestId = 'changed-request';
          return mode === 'always' ? { always: { saved: true } } : {};
        }
        throw new Error('Unexpected fixture mutation');
      },
    },
    lab: {
      async db(query: TemplateStringsArray) {
        if (query.join('').includes('from approval_requests')) return structuredClone(gates);
        return [{ id: 'run', ...binding, botId: mode === 'foreign-run' ? 'foreign' : 'bot', status, remoteId: 'remote' }];
      },
      events: { async waitTerminal() { return { terminalType: 'run.completed', terminalEvents: 1 }; } },
      async run() { return { id: 'run', status, output: 'fixture-output' }; },
    },
  } as unknown as ScenarioContext;
  return { context, bot, mutations, run: () => sendFixtureOnce(context, bot, 'thread', 'fixture input', { kind: 'skill-create', name: 'e2e-probe-owned' }) };
}

describe('observable single-use fixture approval', () => {
  test('only choice once is sent and its exact gate forwarding is confirmed before success', async () => {
    const fixture = harness();
    expect(await fixture.run()).toMatchObject({ fixtureApprovals: 1, fixtureGateForwardConfirmed: true });
    expect(fixture.mutations).toEqual([{ path: '/api/threads/thread/messages', body: { input: 'fixture input' } },
      { path: '/api/approvals/approval/respond', body: { choice: 'once' } }]);
  });

  test('a genuinely ungated turn needs no approval while later tool/host proof remains required', async () => {
    const fixture = harness('no-gate');
    expect(await fixture.run()).toMatchObject({ fixtureApprovals: 0, fixtureGateForwardConfirmed: false });
    expect(fixture.mutations).toHaveLength(1);
  });

  test('unexpected, duplicate, unconfirmed and changed gates fail without a second once', async () => {
    for (const mode of ['duplicate', 'unexpected', 'unconfirmed', 'second', 'changed', 'api-error', 'always'] as const) {
      const fixture = harness(mode);
      await expect(fixture.run()).rejects.toThrow();
      const responses = fixture.mutations.filter((entry) => entry.path.endsWith('/respond'));
      expect(responses.length).toBeLessThanOrEqual(1);
      expect(responses.every((entry) => JSON.stringify(entry.body) === '{"choice":"once"}')).toBe(true);
      if (mode === 'unexpected' || mode === 'duplicate') expect(responses).toHaveLength(0);
    }
  });

  test('scope failure precedes dispatch and foreign run binding is never approved or cancelled', async () => {
    const invalid = harness();
    await expect(sendFixtureOnce(invalid.context, invalid.bot, 'thread', 'input', { kind: 'skill-create', name: 'operator' })).rejects.toThrow('fresh');
    expect(invalid.mutations).toEqual([]);
    const foreign = harness('foreign-run');
    await expect(foreign.run()).rejects.toThrow('binding differs');
    expect(foreign.mutations).toHaveLength(1);
  });

  test('revocation detects a gate immediately, cancels only its owned run and never approves', async () => {
    const fixture = harness();
    await expect(sendFixtureWithoutApproval(fixture.context, fixture.bot, 'thread', 'revoked probe')).rejects.toThrow('no approval is allowed');
    expect(fixture.mutations.map((entry) => entry.path)).toEqual(['/api/threads/thread/messages', '/api/runs/run/cancel']);
    expect(fixture.mutations.some((entry) => entry.path.endsWith('/respond'))).toBe(false);
  });
});
