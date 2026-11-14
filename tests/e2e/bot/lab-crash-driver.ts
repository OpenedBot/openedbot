import { spawn, type ChildProcess } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { Readable } from 'node:stream';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HOST = /^(?:[a-z_][a-z0-9_-]{0,31}@)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const INSTANCE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_OUTPUT = 16_384;

export type LabCrashSsh = { argv: string[]; env: Record<string, string>; runtimeId: string; nonce: string };
type StartSsh = (argv: string[], env: Record<string, string>) => ChildProcess;

/** The remote shell only receives fixed words, UUIDs and a validated instance. */
export function labCrashSsh(argv: string[], env: Record<string, string | undefined>): LabCrashSsh {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: false, strict: true,
    options: { host: { type: 'string' }, instance: { type: 'string' } } });
  if (positionals.length || !values.host || !HOST.test(values.host) || values.host.includes('..')) throw new Error('--host must be an explicit SSH alias or user@host.');
  const instance = values.instance;
  if (instance !== undefined && (!INSTANCE.test(instance) || ['default', 'runs', 'diagnostics', 'creation-audit'].includes(instance))) throw new Error('--instance is not a valid named edge-setup connector.');
  const runtimeId = env.E2E_RECOVERY_RUNTIME_ID ?? '';
  const nonce = env.E2E_RECOVERY_NONCE ?? '';
  if (!UUID.test(runtimeId) || !UUID.test(nonce)) throw new Error('E2E_RECOVERY_RUNTIME_ID and E2E_RECOVERY_NONCE must be canonical UUIDs.');
  const childEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK', 'TMPDIR']
    .flatMap((key) => env[key] === undefined ? [] : [[key, env[key]!]]));
  return {
    runtimeId, nonce, env: childEnv,
    argv: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
      '-o', 'StrictHostKeyChecking=yes', values.host, 'sudo', '-n', 'edge-setup', 'lab', 'gateway-crash',
      '--yes', '--allow-lab-fault', ...(instance ? ['--name', instance] : []), '--runtime-id', runtimeId, '--nonce', nonce, '--json'],
  };
}

function checkedEvidence(output: string, target: LabCrashSsh): Record<string, unknown> {
  let evidence: unknown;
  try { evidence = JSON.parse(output); } catch { throw new Error('The lab command did not return one JSON evidence document.'); }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('The lab command returned invalid evidence.');
  const value = evidence as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== ['schemaVersion', 'kind', 'runtimeId', 'nonce', 'signal', 'stoppedObserved', 'healthy', 'before', 'after'].sort().join(',')) throw new Error('The lab command returned unexpected evidence fields.');
  if (value.schemaVersion !== 1 || value.kind !== 'gateway-crash-restart' || value.runtimeId !== target.runtimeId
    || value.nonce !== target.nonce || value.signal !== 'SIGKILL' || value.stoppedObserved !== true || value.healthy !== true) {
    throw new Error('The lab command did not attest the requested runtime and fault.');
  }
  const process = (input: unknown): input is { pid: number; startedAt: string } => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const candidate = input as Record<string, unknown>;
    return Object.keys(candidate).sort().join(',') === 'pid,startedAt' && typeof candidate.pid === 'number'
      && Number.isSafeInteger(candidate.pid) && candidate.pid > 0 && typeof candidate.startedAt === 'string'
      && Number.isFinite(Date.parse(candidate.startedAt));
  };
  if (!process(value.before) || !process(value.after) || value.before.pid === value.after.pid
    || Date.parse(value.after.startedAt) <= Date.parse(value.before.startedAt)) throw new Error('The lab command returned no distinct process restart evidence.');
  return value;
}

/** SSH stays in the outer recovery driver's process group so its deadline can reap descendants. */
export async function executeLabCrashSsh(target: LabCrashSsh, timeoutMs = 90_000,
  start: StartSsh = (argv, env) => spawn('ssh', argv, { env, stdio: ['ignore', 'pipe', 'pipe'] })): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 90_000) throw new Error('The lab SSH timeout must be between 1 and 90000 ms.');
  const child = start(target.argv, target.env);
  const exited = new Promise<{ code: number; failed: boolean }>((resolve) => {
    child.once('error', () => resolve({ code: 1, failed: true }));
    child.once('exit', (code) => resolve({ code: code ?? 1, failed: false }));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The lab SSH fault driver timed out.')), timeoutMs); });
  const read = async (stream: Readable | null, keep: boolean): Promise<string> => {
    if (!stream) throw new Error('The lab SSH evidence pipe is unavailable.');
    let bytes = 0, output = '';
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTPUT) throw new Error('The lab SSH driver exceeded its bounded output.');
      if (keep) output += decoder.decode(chunk, { stream: true });
    }
    return output + (keep ? decoder.decode() : '');
  };
  try {
    const [output, , status] = await Promise.race([Promise.all([read(child.stdout, true), read(child.stderr, false), exited]), deadline]);
    if (status.failed || status.code !== 0) throw new Error('The lab SSH command failed; remote output is withheld.');
    return checkedEvidence(output, target);
  } finally {
    clearTimeout(timer);
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdout?.destroy(); child.stderr?.destroy();
    await exited;
  }
}

if (import.meta.main) {
  try {
    const evidence = await executeLabCrashSsh(labCrashSsh(Bun.argv.slice(2), process.env));
    console.log(JSON.stringify(evidence));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The lab SSH fault driver failed.');
    process.exitCode = 1;
  }
}
