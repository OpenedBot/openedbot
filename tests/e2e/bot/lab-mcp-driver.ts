import { parseArgs } from 'node:util';
import { LAB_MCP_ACTIONS, parseLabMcpEvidence, requireLabMcpTarget, type LabMcpAction, type LabMcpEvidence, type LabMcpTarget } from './kit/lab-mcp-contract';
import { labMcpProcessEnv, runLabMcpProcess, type LabMcpStart } from './kit/lab-mcp-process';

const HOST = /^(?:[a-z_][a-z0-9_-]{0,31}@)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const INSTANCE = /^[a-z][a-z0-9-]{0,31}$/;
export type LabMcpSsh = { argv: string[]; env: Record<string, string>; target: LabMcpTarget; action: LabMcpAction };

/** Fixed edge-setup verb, known host keys and validated shell-safe metadata only. */
export function labMcpSsh(argv: string[], env: Record<string, string | undefined>): LabMcpSsh {
  const { values } = parseArgs({ args: argv, allowPositionals: false, strict: true,
    options: { host: { type: 'string' }, instance: { type: 'string' } } });
  if (!values.host || !HOST.test(values.host) || values.host.includes('..')) throw new Error('--host must be an explicit SSH alias or user@host.');
  if (!values.instance || !INSTANCE.test(values.instance) || ['default', 'runs', 'diagnostics', 'creation-audit'].includes(values.instance)) {
    throw new Error('--instance must name an explicit nonreserved edge-setup connector.');
  }
  const target = { runtimeId: env.E2E_MCP_RUNTIME_ID ?? '', nonce: env.E2E_MCP_NONCE ?? '', profile: env.E2E_MCP_PROFILE ?? '' };
  requireLabMcpTarget(target);
  const action = env.E2E_MCP_ACTION as LabMcpAction;
  if (env.E2E_ALLOW_LAB_FIXTURES !== '1' || !LAB_MCP_ACTIONS.includes(action)) throw new Error('The lab MCP driver requires E2E_ALLOW_LAB_FIXTURES=1 and a supported action.');
  return { target, action, env: labMcpProcessEnv(env),
    argv: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
      '-o', 'StrictHostKeyChecking=yes', values.host, 'sudo', '-n', 'edge-setup', 'lab', 'mcp-fixture', action,
      '--yes', '--allow-lab-fault', '--name', values.instance, '--runtime-id', target.runtimeId, '--nonce', target.nonce, '--profile', target.profile, '--json'],
  };
}

/** The runner's outer process group owns SSH descendants and its deadline. */
export async function executeLabMcpSsh(command: LabMcpSsh, timeoutMs = 90_000, start?: LabMcpStart): Promise<LabMcpEvidence> {
  const output = await runLabMcpProcess('ssh', command.argv, command.env, timeoutMs, false, start);
  return parseLabMcpEvidence(output, command.target, command.action);
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await executeLabMcpSsh(labMcpSsh(Bun.argv.slice(2), process.env)))); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'The lab MCP driver failed.');
    process.exitCode = 1;
  }
}
