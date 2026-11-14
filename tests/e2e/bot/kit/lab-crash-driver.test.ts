import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { executeLabCrashSsh, labCrashSsh } from '../lab-crash-driver';

const runtimeId = '750b6e7c-6fb3-4fbd-8d79-b4bb8451b69a';
const nonce = 'e91f2fdf-daab-49c7-9e61-f638fdaa3074';
const env = { E2E_RECOVERY_RUNTIME_ID: runtimeId, E2E_RECOVERY_NONCE: nonce, HOME: '/test-home', PATH: process.env.PATH,
  SSH_AUTH_SOCK: '/agent.sock', API_DATABASE_URL: 'private-database', RELAY_INTERNAL_TOKEN: 'private-relay' };
const target = () => labCrashSsh(['--host', 'lab-host-01', '--instance', 'lab-instance'], env);
const proof = { schemaVersion: 1, kind: 'gateway-crash-restart', runtimeId, nonce, signal: 'SIGKILL', stoppedObserved: true, healthy: true,
  before: { pid: 100, startedAt: '2026-11-09T02:00:00Z' }, after: { pid: 200, startedAt: '2026-11-09T02:00:03Z' } };

test('lab SSH argv fixes the operation, pins host keys and forwards no application secrets', () => {
  const command = target();
  expect(command.argv).toContain('StrictHostKeyChecking=yes');
  expect(command.argv).toContain('BatchMode=yes');
  expect(command.argv.slice(command.argv.indexOf('lab-host-01') + 1)).toEqual(['sudo', '-n', 'edge-setup', 'lab', 'gateway-crash', '--yes', '--allow-lab-fault', '--name', 'lab-instance', '--runtime-id', runtimeId, '--nonce', nonce, '--json']);
  expect(command.env).toEqual({ HOME: '/test-home', PATH: process.env.PATH!, SSH_AUTH_SOCK: '/agent.sock' });
  expect(JSON.stringify(command)).not.toContain('private-');
  expect(labCrashSsh(['--host', 'operator@lab-host-01'], env).argv).toContain('operator@lab-host-01');
});

test('lab SSH parser refuses untrusted shell words, options, instances and missing identifiers', () => {
  for (const host of ['-oProxyCommand=id', 'host;id', 'host name', 'user@host@other', 'https://host', 'host$(id)', 'host\nname']) expect(() => labCrashSsh(['--host', host], env)).toThrow();
  for (const instance of ['', '../prod', 'default', 'runs', '--other', 'A', 'a'.repeat(33)]) expect(() => labCrashSsh(['--host', 'lab', '--instance', instance], env)).toThrow();
  expect(() => labCrashSsh(['--host', 'lab', '--command', 'true'], env)).toThrow();
  expect(() => labCrashSsh(['--host', 'lab', 'unexpected'], env)).toThrow();
  expect(() => labCrashSsh(['--host', 'lab'], { ...env, E2E_RECOVERY_RUNTIME_ID: '' })).toThrow('UUID');
  expect(() => labCrashSsh(['--host', 'lab'], { ...env, E2E_RECOVERY_NONCE: '../nonce' })).toThrow('UUID');
});

test('lab SSH accepts only one target-bound evidence document', async () => {
  const start = (source: string) => () => spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  expect(await executeLabCrashSsh(target(), 1000, start(`process.stdout.write(${JSON.stringify(JSON.stringify(proof))})`))).toEqual(proof);
  await expect(executeLabCrashSsh(target(), 1000, start('process.stdout.write("not evidence")'))).rejects.toThrow('JSON');
  await expect(executeLabCrashSsh(target(), 1000, start(`process.stdout.write(${JSON.stringify(JSON.stringify({ ...proof, nonce: runtimeId }))})`))).rejects.toThrow('requested runtime');
  await expect(executeLabCrashSsh(target(), 1000, start('process.stderr.write("private-secret");process.exit(4)'))).rejects.toThrow('output is withheld');
});

test('lab SSH bounds output and time and reaps its direct child', async () => {
  let child: ChildProcess | undefined;
  const start = (source: string) => () => (child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] }));
  await expect(executeLabCrashSsh(target(), 1000, start('process.stdout.write("x".repeat(16385));setInterval(()=>{},1000)'))).rejects.toThrow('bounded output');
  expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
  await expect(executeLabCrashSsh(target(), 20, start('setInterval(()=>{},1000)'))).rejects.toThrow('timed out');
  expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
});
