import { describe, expect, test } from 'bun:test';
import { LabMcpFixture } from './lab-mcp-fixture';
import { labMcpNames, parseLabMcpEvidence, requireLabMcpTarget, type LabMcpAction, type LabMcpEvidence } from './lab-mcp-contract';

const target = { runtimeId: '750b6e7c-6fb3-4fbd-8d79-b4bb8451b69a', nonce: 'e91f2fdf-daab-49c7-9e61-f638fdaa3074', profile: 'e2e-mcp-owned' };
const secret = `MCP_${'a'.repeat(32)}`;
function proof(action: LabMcpAction, patch: Partial<LabMcpEvidence> = {}): LabMcpEvidence {
  return { schemaVersion: 1, kind: 'mcp-fixture', action, ...target, ...labMcpNames(target),
    installed: action !== 'remove', removed: action === 'remove', replayed: false,
    online: action !== 'offline' && action !== 'remove', calls: [], processes: [], starts: 0, ...(action === 'setup' ? { secret } : {}), ...patch };
}

describe('ownership-bound native MCP documents', () => {
  test('derives the exact unclamped native names and accepts only the requested operation', () => {
    const names = labMcpNames(target);
    expect(names.serverName).toBe('e2e_e91f2fdfdaab49c79e61f638fdaa3074');
    expect(names.toolName).toBe(`mcp__${names.serverName}__read_probe`);
    expect(names.toolName.length).toBeLessThanOrEqual(64);
    for (const action of ['setup', 'online', 'offline', 'receipts', 'remove'] as const) {
      expect(parseLabMcpEvidence(JSON.stringify(proof(action)), target, action)).toEqual(proof(action));
    }
    for (const changed of [{ runtimeId: 'not-a-uuid' }, { nonce: '../nonce' }, { profile: 'operator' }, { profile: 'e2e-../other' }, { profile: 'e2e-' + 'a'.repeat(60) }]) {
      expect(() => requireLabMcpTarget({ ...target, ...changed })).toThrow();
    }
  });

  test('rejects cross-target, contradictory, invented or secret-bearing receipt evidence', () => {
    for (const patch of [
      { nonce: target.runtimeId }, { runtimeId: target.nonce }, { profile: 'e2e-foreign' }, { serverName: 'foreign' },
      { toolName: 'read_probe' }, { schemaVersion: 2 }, { action: 'remove' }, { online: 'yes' }, { removed: true },
      { secret }, { token: 'private' }, { calls: [{ challenge: 'a', succeeded: 'yes' }] },
      { calls: [{ challenge: '', succeeded: true }] }, { calls: [{ challenge: 'a', succeeded: true, secret }] },
      { calls: Array.from({ length: 129 }, () => ({ challenge: 'a', succeeded: true })) },
      { calls: [{ challenge: 'unsafe\nchallenge', succeeded: true }] },
      { starts: 1 }, { starts: -1 }, { starts: 33 }, { starts: 0.5 },
      { starts: 1, processes: [{ pid: 0, startTicks: '100', running: false }] },
      { starts: 1, processes: [{ pid: 123, startTicks: 'invalid', running: false }] },
      { starts: 1, processes: [{ pid: 123, startTicks: '100', running: 'no' }] },
      { starts: 2, processes: [{ pid: 123, startTicks: '100', running: false }, { pid: 123, startTicks: '100', running: false }] },
    ]) expect(() => parseLabMcpEvidence(JSON.stringify({ ...proof('receipts'), ...patch }), target, 'receipts')).toThrow();
    for (const patch of [{ secret: undefined }, { secret: 'invented' }, { installed: false }, { online: false }]) {
      expect(() => parseLabMcpEvidence(JSON.stringify({ ...proof('setup'), ...patch }), target, 'setup')).toThrow();
    }
    for (const output of ['not JSON', 'null', '[]', 'x'.repeat(32769)]) expect(() => parseLabMcpEvidence(output, target, 'receipts')).toThrow();
    expect(() => parseLabMcpEvidence(JSON.stringify(proof('remove', { starts: 1, processes: [{ pid: 123, startTicks: '100', running: true }] })), target, 'remove')).toThrow('state contradicts');
  });
});

describe('native MCP partial success and cleanup', () => {
  test('normal lifecycle keeps the secret out of receipts and removes only once', async () => {
    const actions: LabMcpAction[] = [];
    const fixture = new LabMcpFixture(target, async (action) => { actions.push(action); return proof(action); });
    expect(() => fixture.secret).toThrow('not been confirmed');
    await expect(fixture.setOnline(true)).rejects.toThrow('not owned');
    await fixture.setup();
    expect(fixture.secret).toBe(secret);
    await fixture.setOnline(false); await fixture.setOnline(true);
    expect(await fixture.receipts()).toEqual([]);
    await fixture.cleanup(); await fixture.cleanup();
    expect(actions).toEqual(['setup', 'offline', 'online', 'receipts', 'remove']);
    expect(() => fixture.secret).toThrow();
    await expect(fixture.setup()).rejects.toThrow('already attempted');
  });

  test('a lost setup reply is reconciled before idempotent setup replay recovers the same secret', async () => {
    const actions: LabMcpAction[] = []; let setups = 0;
    const fixture = new LabMcpFixture(target, async (action) => {
      actions.push(action);
      if (action === 'setup' && setups++ === 0) throw new Error('Lost transport response');
      return proof(action, action === 'setup' ? { replayed: true } : {});
    });
    await fixture.setup();
    expect(fixture.setupReconciled).toBe(true);
    expect(fixture.secret).toBe(secret);
    await fixture.cleanup();
    expect(actions).toEqual(['setup', 'receipts', 'setup', 'remove']);
  });

  test('an interrupted preparing ownership receipt permits exact setup resume', async () => {
    const actions: LabMcpAction[] = []; let setups = 0;
    const fixture = new LabMcpFixture(target, async (action) => {
      actions.push(action);
      if (action === 'setup' && setups++ === 0) throw new Error('Interrupted after ownership receipt');
      return proof(action, action === 'receipts' ? { installed: false, online: false } : {});
    });
    await fixture.setup(); await fixture.cleanup();
    expect(actions).toEqual(['setup', 'receipts', 'setup', 'remove']);
  });

  test('unknown or foreign setup ownership never authorizes blind retry or delete', async () => {
    for (const foreign of [false, true]) {
      const actions: LabMcpAction[] = [];
      const fixture = new LabMcpFixture(target, async (action) => {
        actions.push(action);
        if (action === 'receipts' && foreign) return proof(action, { profile: 'e2e-foreign' });
        throw new Error('Unavailable');
      });
      await expect(fixture.setup()).rejects.toThrow('Ownership could not be reconciled');
      await expect(fixture.cleanup()).rejects.toThrow('ownership receipt is unavailable');
      expect(actions).toEqual(['setup', 'receipts', 'receipts']);
    }
  });

  test('a confirmed owned but failed setup is still precisely cleaned', async () => {
    const actions: LabMcpAction[] = [];
    const fixture = new LabMcpFixture(target, async (action) => {
      actions.push(action);
      if (action === 'setup') throw new Error('Setup failed');
      return proof(action);
    });
    await expect(fixture.setup()).rejects.toThrow('Setup failed');
    await fixture.cleanup();
    expect(actions).toEqual(['setup', 'receipts', 'setup', 'remove']);
  });

  test('a lost remove reply is confirmed read-only and never blindly deleted again', async () => {
    const actions: LabMcpAction[] = [];
    const fixture = new LabMcpFixture(target, async (action) => {
      actions.push(action);
      if (action === 'remove') throw new Error('Lost removal response');
      return proof(action, action === 'receipts' ? { removed: true, installed: false, online: false } : {});
    });
    await fixture.setup(); await fixture.cleanup(); await fixture.cleanup();
    expect(actions).toEqual(['setup', 'remove', 'receipts']);
  });

  test('a failed remove with a live receipt remains an actionable failure', async () => {
    const actions: LabMcpAction[] = [];
    const fixture = new LabMcpFixture(target, async (action) => {
      actions.push(action);
      if (action === 'remove') throw new Error('Native child still running');
      return proof(action);
    });
    await fixture.setup();
    await expect(fixture.cleanup()).rejects.toThrow('removal is unconfirmed');
    expect(actions).toEqual(['setup', 'remove', 'receipts']);
  });

  test('lost remove and unavailable receipts retain exact recovery coordinates without a second delete', async () => {
    const actions: LabMcpAction[] = [];
    const fixture = new LabMcpFixture(target, async (action) => {
      actions.push(action);
      if (action !== 'setup') throw new Error('Driver unavailable');
      return proof(action);
    });
    await fixture.setup();
    await expect(fixture.cleanup()).rejects.toThrow(`nonce=${target.nonce}, profile=${target.profile}`);
    expect(actions).toEqual(['setup', 'remove', 'receipts']);
  });

  test('a removed ownership receipt is never recreated', async () => {
    const actions: LabMcpAction[] = [];
    const fixture = new LabMcpFixture(target, async (action) => {
      actions.push(action);
      if (action === 'setup') throw new Error('Already removed');
      return proof(action, { installed: false, removed: true, online: false });
    });
    await expect(fixture.setup()).rejects.toThrow('will not recreate');
    await fixture.cleanup();
    expect(actions).toEqual(['setup', 'receipts']);
  });

  test('native process identity and call histories cannot regress between receipts', async () => {
    for (const corrupted of ['calls', 'starts', 'identity'] as const) {
      let receipts = 0;
      const history = { calls: [{ challenge: 'one', succeeded: true }], starts: 1,
        processes: [{ pid: 123, startTicks: '100', running: true }] };
      const fixture = new LabMcpFixture(target, async (action) => {
        if (action !== 'receipts') return proof(action);
        if (receipts++ === 0) return proof(action, history);
        return proof(action, { ...history, ...(corrupted === 'calls' ? { calls: [] } : corrupted === 'starts'
          ? { starts: 0, processes: [] } : { processes: [{ pid: 124, startTicks: '101', running: false }] }) });
      });
      await fixture.setup(); await fixture.snapshot();
      await expect(fixture.snapshot()).rejects.toThrow('history regressed');
    }
  });
});
