import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { executeLabMcpSsh, labMcpSsh } from '../lab-mcp-driver';
import { executeLabMcpCommand } from './lab-mcp-command';
import { labMcpNames, type LabMcpEvidence } from './lab-mcp-contract';
import { labMcpProcessEnv, runLabMcpProcess, type LabMcpStart } from './lab-mcp-process';
import { readConfig } from './config';

const target = { runtimeId: '750b6e7c-6fb3-4fbd-8d79-b4bb8451b69a', nonce: 'e91f2fdf-daab-49c7-9e61-f638fdaa3074', profile: 'e2e-mcp-owned' };
const env = { E2E_ALLOW_LAB_FIXTURES: '1', E2E_MCP_RUNTIME_ID: target.runtimeId, E2E_MCP_NONCE: target.nonce,
  E2E_MCP_PROFILE: target.profile, E2E_MCP_ACTION: 'setup', HOME: '/test-home', PATH: process.env.PATH ?? '/usr/bin',
  SSH_AUTH_SOCK: '/agent.sock', API_DATABASE_URL: 'private-database', RELAY_INTERNAL_TOKEN: 'private-relay' };
const args = ['--host', 'lab-host-01', '--instance', 'lab-instance'];
const evidence: LabMcpEvidence = { schemaVersion: 1, kind: 'mcp-fixture', action: 'setup', ...target, ...labMcpNames(target),
  online: true, installed: true, removed: false, replayed: false, calls: [], processes: [], starts: 0, secret: `MCP_${'a'.repeat(32)}` };
const start = (program: string): LabMcpStart => () => spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });

describe('explicit guarded lab MCP driver', () => {
  test('uses fixed CLI words, strict host attestation and no application secrets', () => {
    const command = labMcpSsh(args, env);
    expect(command.target).toEqual(target);
    expect(command.argv).toContain('StrictHostKeyChecking=yes');
    expect(command.argv).toContain('BatchMode=yes');
    expect(command.argv.slice(command.argv.indexOf('lab-host-01') + 1)).toEqual(['sudo', '-n', 'edge-setup', 'lab', 'mcp-fixture', 'setup',
      '--yes', '--allow-lab-fault', '--name', 'lab-instance', '--runtime-id', target.runtimeId, '--nonce', target.nonce, '--profile', target.profile, '--json']);
    expect(command.env).toEqual({ HOME: env.HOME, PATH: env.PATH, SSH_AUTH_SOCK: env.SSH_AUTH_SOCK });
    expect(command.env.API_DATABASE_URL).toBeUndefined();
    expect(command.env.E2E_MCP_PROFILE).toBeUndefined();
    for (const host of ['-oProxyCommand=id', 'host;id', 'host name', 'a@b@c', 'https://host', 'host$(id)', 'host\nname']) {
      expect(() => labMcpSsh(['--host', host, '--instance', 'owned'], env)).toThrow();
    }
    for (const instance of ['', 'default', '../prod', 'runs', '--option', 'A']) expect(() => labMcpSsh(['--host', 'lab', '--instance', instance], env)).toThrow();
    expect(() => labMcpSsh(['--host', 'lab'], env)).toThrow('--instance');
    expect(() => labMcpSsh([...args, '--command', 'id'], env)).toThrow();
    for (const patch of [{ E2E_ALLOW_LAB_FIXTURES: '' }, { E2E_MCP_ACTION: 'delete-all' }, { E2E_MCP_NONCE: '../nonce' }, { E2E_MCP_PROFILE: 'operator' }]) {
      expect(() => labMcpSsh(args, { ...env, ...patch })).toThrow();
    }
  });

  test('requires explicit fixture opt-in, argv and target at configuration time', () => {
    const base = { E2E_ALLOW_REAL_RUNS: '1', WORKER_DATABASE_URL: 'postgres://unused@127.0.0.1/test', E2E_RUNTIME_ID: target.runtimeId };
    expect(readConfig([], base).mcpFixtureCommand).toBeNull();
    for (const value of ['[]', 'not-json', '"shell words"', '["bun",2]', '["bun",""]', '["bun"]']) {
      expect(() => readConfig([], { ...base, E2E_MCP_FIXTURE_ARGV: value })).toThrow();
    }
    for (const runtimeId of ['', 'operator-runtime', target.runtimeId.toUpperCase()]) {
      expect(() => readConfig([], { ...base, E2E_ALLOW_LAB_FIXTURES: '1', E2E_RUNTIME_ID: runtimeId, E2E_MCP_FIXTURE_ARGV: '["driver"]' })).toThrow('E2E_RUNTIME_ID');
    }
    expect(readConfig([], { ...base, E2E_ALLOW_LAB_FIXTURES: '1', E2E_MCP_FIXTURE_ARGV: JSON.stringify(['bun', 'driver.ts', 'literal;arg']) }).mcpFixtureCommand)
      .toEqual(['bun', 'driver.ts', 'literal;arg']);
  });

  test('SSH result is normalized only after target/action evidence validation', async () => {
    const command = labMcpSsh(args, env);
    expect(await executeLabMcpSsh(command, 1000, start(`console.log(${JSON.stringify(JSON.stringify(evidence))})`))).toEqual(evidence);
    await expect(executeLabMcpSsh(command, 1000, start('console.log("PRIVATE-BAD-OUTPUT")'))).rejects.toThrow('JSON evidence');
    await expect(executeLabMcpSsh(command, 1000, start(`console.log(${JSON.stringify(JSON.stringify({ ...evidence, nonce: target.runtimeId }))})`))).rejects.toThrow('exact target');
    await expect(executeLabMcpSsh(command, 1000, start('console.error("private-secret");process.exit(4)'))).rejects.toThrow('output is withheld');
  });

  test('the outer driver receives exact target metadata and a credential-free environment', async () => {
    const program = `if(process.env.E2E_MCP_RUNTIME_ID!==${JSON.stringify(target.runtimeId)}||process.env.E2E_MCP_PROFILE!==${JSON.stringify(target.profile)}
      ||process.env.E2E_MCP_ACTION!=='setup'||process.env.API_DATABASE_URL||process.env.RELAY_INTERNAL_TOKEN)process.exit(5);
      const value=${JSON.stringify(evidence)};value.nonce=process.env.E2E_MCP_NONCE; console.log(JSON.stringify(value));`;
    expect(await executeLabMcpCommand([process.execPath, '-e', program], target, 'setup', 1000)).toEqual(evidence);
    expect(labMcpProcessEnv({ PATH: 'path', HOME: 'home', OPENAI_API_KEY: 'private', DATABASE_URL: 'private', E2E_PASSWORD: 'private' })).toEqual({ PATH: 'path', HOME: 'home' });
  });

  test('output flood, launch failure and hung descendants fail within bounds and are reaped', async () => {
    await expect(runLabMcpProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(32769));setInterval(()=>{},1000)'], {}, 1000)).rejects.toThrow('bounded output');
    await expect(runLabMcpProcess(process.execPath, ['-e', 'process.stderr.write("x".repeat(32769));setInterval(()=>{},1000)'], {}, 1000)).rejects.toThrow('bounded output');
    await expect(runLabMcpProcess('/this-lab-command-does-not-exist', [], {}, 1000)).rejects.toThrow('output is withheld');
    const descendant = `const{spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}).unref();setInterval(()=>{},1000);`;
    const started = Date.now();
    await expect(runLabMcpProcess(process.execPath, ['-e', descendant], {}, 50)).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
