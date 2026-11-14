import { expect, test } from 'bun:test';
import { browserSsh } from '../lab-browser-driver';
import { readConfig } from './config';
import { LabBrowserFixture, executeBrowserCommand, parseBrowserEvidence, type BrowserAction, type BrowserEvidence } from './lab-browser-fixture';

const identity = { runtimeId: '750b6e7c-6fb3-4fbd-8d79-b4bb8451b69a', nonce: '12345678-1234-4234-8234-123456789012', profile: 'e2e-browser' };
const doc = (action: BrowserAction, extra: Partial<BrowserEvidence> = {}): BrowserEvidence => ({ schemaVersion: 2, kind: 'browser-fixture',
  ...identity, action, placement: 'user-unit', configRestored: action === 'remove',
  sidecar: { unit: `e2e-hermes-browser-${identity.nonce.replaceAll('-', '')}.service`, invocationId: 'b'.repeat(32), pid: 314, startTicks: '12345',
    active: action !== 'remove', stopped: action === 'remove', resourcesVerified: true }, installed: action !== 'remove', removed: action === 'remove', replayed: false,
  privateUrlException: action !== 'remove', backend: 'local', executable: '/opt/chromium/chrome', version: 'Chromium 130', archiveSha256: 'a'.repeat(64), target: 'linux-x64', ...extra });
const env = { E2E_ALLOW_LAB_FIXTURES: '1', E2E_BROWSER_ACTION: 'setup', E2E_BROWSER_RUNTIME_ID: identity.runtimeId,
  E2E_BROWSER_NONCE: identity.nonce, E2E_BROWSER_PROFILE: identity.profile, OPENAI_API_KEY: 'never-forward', DATABASE_URL: 'never-forward' };

test('browser driver fixes CLI words, strict host checking, explicit target and credential-free environment', () => {
  const command = browserSsh(['--host','lab-host-01','--instance','lab-instance'], env);
  expect(command.argv.slice(-3)).toEqual(['--schema-version', '2', '--json']);
  expect(command.argv).toContain('browser-fixture'); expect(command.argv).not.toContain('mcp-fixture');
  const sameWord = browserSsh(['--host','mcp-fixture','--instance','mcp-fixture'], env);
  expect(sameWord.argv[10]).toBe('mcp-fixture'); expect(sameWord.argv[20]).toBe('mcp-fixture');
  expect(command.argv).toContain('StrictHostKeyChecking=yes'); expect(command.env).not.toHaveProperty('OPENAI_API_KEY');
  for (const bad of [{ E2E_ALLOW_LAB_FIXTURES: '0' }, { E2E_BROWSER_PROFILE: 'operator' }, { E2E_BROWSER_ACTION: 'shell' },
    { E2E_BROWSER_RUNTIME_ID: identity.runtimeId.toUpperCase() }, { E2E_BROWSER_NONCE: '$(touch /tmp/no)' }]) {
    expect(() => browserSsh(['--host','lab-host-01','--instance','lab-instance'], { ...env, ...bad })).toThrow();
  }
  expect(() => browserSsh(['--host','x;id','--instance','lab-instance'], env)).toThrow();
});

test('browser evidence refuses unsafe identity, state, artifact and invented evidence', () => {
  expect(parseBrowserEvidence(JSON.stringify(doc('setup')), identity, 'setup').installed).toBe(true);
  for (const extra of [{ profile: 'e2e-other' }, { runtimeId: crypto.randomUUID() }, { nonce: crypto.randomUUID() }, { privateUrlException: false },
    { backend: 'cloud' }, { archiveSha256: 'bad' }, { executable: 'relative' }, { removed: true }, { token: 'no' }]) {
    expect(() => parseBrowserEvidence(JSON.stringify({ ...doc('setup'), ...extra }), identity, 'setup')).toThrow();
  }
  expect(() => parseBrowserEvidence(JSON.stringify(doc('remove', { privateUrlException: true })), identity, 'remove')).toThrow();
  expect(() => parseBrowserEvidence('x'.repeat(32769), identity, 'receipts')).toThrow();
});

test('lost setup response requires exact receipt before idempotent replay and final owned removal', async () => {
  const actions: BrowserAction[] = []; let setups = 0;
  const fixture = new LabBrowserFixture(identity, async (action) => {
    actions.push(action); if (action === 'setup' && setups++ === 0) throw new Error('lost');
    return doc(action, action === 'receipts' ? { installed: false, privateUrlException: false, executable: '', version: '', archiveSha256: '', target: '' } : {});
  });
  await fixture.setup(); expect(fixture.setupReconciled).toBe(true); await fixture.cleanup(); await fixture.cleanup();
  expect(actions).toEqual(['setup','receipts','setup','remove']);
});

test('foreign or unavailable ownership cannot authorize blind replay or cleanup', async () => {
  const actions: BrowserAction[] = [];
  const fixture = new LabBrowserFixture(identity, async (action) => {
    actions.push(action); if (action === 'setup') throw new Error('lost'); return doc(action, { profile: 'operator' });
  });
  await expect(fixture.setup()).rejects.toThrow('ownership unconfirmed');
  await expect(fixture.cleanup()).rejects.toThrow('ownership unconfirmed');
  expect(actions).toEqual(['setup','receipts','receipts']);
});

test('lost remove reply is confirmed read-only; incomplete remove stays failure without duplicate delete', async () => {
  for (const removed of [true, false]) {
    const actions: BrowserAction[] = [];
    const fixture = new LabBrowserFixture(identity, async (action) => {
      actions.push(action); if (action === 'remove') throw new Error('lost');
      return doc(action, action === 'receipts' ? { installed: !removed, removed, configRestored: removed, privateUrlException: !removed, sidecar: doc(removed ? 'remove' : 'setup').sidecar } : {});
    });
    await fixture.setup();
    if (removed) await fixture.cleanup(); else await expect(fixture.cleanup()).rejects.toThrow('removal incomplete');
    expect(actions).toEqual(['setup','remove','receipts']);
  }
});

 test('private browser exception configuration requires explicit opt-in, argv and canonical runtime', () => {
  const base = { E2E_ALLOW_REAL_RUNS: '1', WORKER_DATABASE_URL: 'postgres://unused@127.0.0.1/test', E2E_RUNTIME_ID: identity.runtimeId };
  expect(readConfig([], base).browserFixtureCommand).toBeNull();
  for (const argv of ['[]', 'not-json', '["driver",2]', '["driver",""]', '["driver"]']) {
    expect(() => readConfig([], { ...base, E2E_BROWSER_FIXTURE_ARGV: argv })).toThrow();
  }
  expect(() => readConfig([], { ...base, E2E_RUNTIME_ID: '', E2E_ALLOW_LAB_FIXTURES: '1', E2E_BROWSER_FIXTURE_ARGV: '["driver"]' })).toThrow('E2E_RUNTIME_ID');
  expect(readConfig([], { ...base, E2E_ALLOW_LAB_FIXTURES: '1', E2E_BROWSER_FIXTURE_ARGV: '["bun","driver.ts"]' }).browserFixtureCommand).toEqual(['bun','driver.ts']);
});

test('lost remove and missing receipt remain actionable without a second mutation', async () => {
  const actions: BrowserAction[] = [];
  const fixture = new LabBrowserFixture(identity, async (action) => {
    actions.push(action); if (action !== 'setup') throw new Error('unavailable'); return doc(action);
  });
  await fixture.setup(); await expect(fixture.cleanup()).rejects.toThrow('no second delete');
  expect(actions).toEqual(['setup','remove','receipts']);
});

test('a terminal removed receipt never authorizes recreation or another removal', async () => {
  const actions: BrowserAction[] = [];
  const fixture = new LabBrowserFixture(identity, async (action) => {
    actions.push(action); if (action === 'setup') throw new Error('lost');
    return doc(action, { installed: false, removed: true, privateUrlException: false, configRestored: true, sidecar: null });
  });
  await expect(fixture.setup()).rejects.toThrow('cannot authorize recreation'); await fixture.cleanup();
  expect(actions).toEqual(['setup','receipts']);
});

test('outer browser command binds metadata without forwarding application credentials', async () => {
  const program = `if(process.env.E2E_BROWSER_RUNTIME_ID!==${JSON.stringify(identity.runtimeId)}
    ||process.env.E2E_BROWSER_PROFILE!==${JSON.stringify(identity.profile)}||process.env.E2E_BROWSER_ACTION!=='setup'
    ||process.env.DATABASE_URL||process.env.OPENAI_API_KEY)process.exit(4);
    console.log(${JSON.stringify(JSON.stringify(doc('setup')))});`;
  expect(await executeBrowserCommand([process.execPath,'-e',program], identity, 'setup')).toEqual(doc('setup'));
});

test('V2 requires real sidecar placement, exact owned unit, native identity and resource proof', () => {
  const valid = doc('setup');
  const old = { ...valid, schemaVersion: 1 } as Record<string, unknown>;
  delete old.placement; delete old.configRestored; delete old.sidecar;
  expect(() => parseBrowserEvidence(JSON.stringify(old), identity, 'setup')).toThrow('schema');
  for (const patch of [{ placement: 'gateway' }, { sidecar: null }, { configRestored: true }]) {
    expect(() => parseBrowserEvidence(JSON.stringify({ ...valid, ...patch }), identity, 'setup')).toThrow();
  }
  for (const patch of [{ unit: 'operator.service' }, { invocationId: 'unknown' }, { pid: 0 }, { startTicks: '0' },
    { active: false }, { stopped: true }, { resourcesVerified: false }, { cdpUrl: 'http://private' }]) {
    expect(() => parseBrowserEvidence(JSON.stringify({ ...valid, sidecar: { ...valid.sidecar, ...patch } }), identity, 'setup')).toThrow();
  }
  for (const patch of [{ active: true }, { stopped: false }, { resourcesVerified: false }]) {
    const removed = doc('remove');
    expect(() => parseBrowserEvidence(JSON.stringify({ ...removed, sidecar: { ...removed.sidecar, ...patch } }), identity, 'remove')).toThrow();
  }
  expect(() => parseBrowserEvidence(JSON.stringify(doc('remove', { configRestored: false })), identity, 'remove')).toThrow();
});

test('cleanup cannot substitute or drop an observed sidecar identity', async () => {
  for (const patch of [{ unit: 'foreign.service' }, { invocationId: 'c'.repeat(32) }, { pid: 315 }, { startTicks: '12346' }, null]) {
    const fixture = new LabBrowserFixture(identity, async (action) => {
      const result = doc(action);
      return action === 'setup' ? result : { ...result, sidecar: patch === null ? null : { ...result.sidecar!, ...patch } };
    });
    await fixture.setup();
    await expect(fixture.cleanup()).rejects.toThrow('no second delete');
  }
});

test('cleanup returns confirmed stop and restore evidence after a lost reply', async () => {
  const fixture = new LabBrowserFixture(identity, async (action) => {
    if (action === 'remove') throw new Error('lost');
    return action === 'receipts' ? { ...doc('remove'), action } : doc(action);
  });
  const started = await fixture.setup(); const removed = await fixture.cleanup();
  expect(removed?.configRestored).toBe(true); expect(removed?.sidecar?.stopped).toBe(true);
  expect(removed?.sidecar?.active).toBe(false); expect(removed?.sidecar?.pid).toBe(started.sidecar?.pid);
  expect(removed?.sidecar?.invocationId).toBe(started.sidecar?.invocationId);
});

test('a V1 response never authorizes replay or blind removal and reports recovery coordinates', async () => {
  const old = { ...doc('setup'), schemaVersion: 1 } as Record<string, unknown>;
  delete old.placement; delete old.configRestored; delete old.sidecar;
  const actions: BrowserAction[] = [];
  const fixture = new LabBrowserFixture(identity, async (action) => {
    actions.push(action);
    return { ...old, action } as unknown as BrowserEvidence;
  });
  await expect(fixture.setup()).rejects.toThrow(`runtime=${identity.runtimeId}, nonce=${identity.nonce}, profile=${identity.profile}`);
  await expect(fixture.cleanup()).rejects.toThrow('ownership unconfirmed');
  expect(actions).toEqual(['setup','receipts','receipts']);
});

test('preparing before any process can restore without inventing a process identity', async () => {
  const actions: BrowserAction[] = [];
  const fixture = new LabBrowserFixture(identity, async (action) => {
    actions.push(action);
    if (action === 'setup') throw new Error('preparation interrupted');
    return action === 'remove' ? doc(action, { sidecar: null })
      : doc(action, { installed: false, privateUrlException: false, sidecar: null });
  });
  await expect(fixture.setup()).rejects.toThrow('preparation interrupted');
  const cleanup = await fixture.cleanup();
  expect(cleanup?.sidecar).toBeNull(); expect(cleanup?.configRestored).toBe(true);
  expect(actions).toEqual(['setup','receipts','setup','remove']);
});

test('receipts expose a stopped process before config restoration without accepting incomplete cleanup', async () => {
  const receipt = doc('receipts', { sidecar: doc('remove').sidecar });
  expect(parseBrowserEvidence(JSON.stringify(receipt), identity, 'receipts').installed).toBe(true);
  const fixture = new LabBrowserFixture(identity, async (action) => {
    if (action === 'remove') throw new Error('restore interrupted after stop');
    return action === 'receipts' ? receipt : doc(action);
  });
  await fixture.setup(); await expect(fixture.cleanup()).rejects.toThrow('removal incomplete');
});

test('restored config with a still-active sidecar is readable partial evidence and never complete cleanup', async () => {
  const receipt = doc('receipts', { installed: false, privateUrlException: false, configRestored: true });
  expect(parseBrowserEvidence(JSON.stringify(receipt), identity, 'receipts').configRestored).toBe(true);
  const fixture = new LabBrowserFixture(identity, async (action) => {
    if (action === 'remove') throw new Error('stop interrupted after restore');
    return action === 'receipts' ? receipt : doc(action);
  });
  await fixture.setup(); await expect(fixture.cleanup()).rejects.toThrow('removal incomplete');
});
