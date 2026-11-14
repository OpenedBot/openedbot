import { spawn, type ChildProcess } from 'node:child_process';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import { LAB_MCP_MAX_OUTPUT } from './lab-mcp-contract';

export type LabMcpStart = (command: string, argv: string[], env: Record<string, string>, detached: boolean) => ChildProcess;

/** The driver receives SSH/process coordinates, never application or provider credentials. */
export function labMcpProcessEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK', 'TMPDIR', 'SystemRoot', 'ComSpec', 'PATHEXT', 'windir']
    .flatMap((key) => env[key] === undefined ? [] : [[key, env[key]!]]));
}

/** A driver owns its process group; its SSH child stays inside that outer group. */
export async function runLabMcpProcess(command: string, argv: string[], env: Record<string, string>, timeoutMs: number, detached = true,
  start: LabMcpStart = (executable, args, childEnv, group) => spawn(executable, args, { env: childEnv, detached: group, stdio: ['ignore', 'pipe', 'pipe'] }), maximumTimeoutMs = 120_000): Promise<string> {
  if (!command || argv.some((part) => typeof part !== 'string' || !part)) throw new Error('The lab MCP driver requires explicit argv.');
  if (!Number.isSafeInteger(maximumTimeoutMs) || maximumTimeoutMs < 1 || maximumTimeoutMs > 360_000) throw new Error('Invalid bounded lab command timeout ceiling.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > maximumTimeoutMs) throw new Error(`The lab MCP driver timeout must be between 1 and ${maximumTimeoutMs} ms.`);
  const processGroup = detached && process.platform !== 'win32';
  // Bun otherwise reloads the repository's .env files after env filtering.
  const childArgs = /^bun(?:\.exe)?$/.test(basename(command)) ? ['--no-env-file', ...argv] : argv;
  const child = start(command, childArgs, env, processGroup);
  const exited = new Promise<{ code: number; failed: boolean }>((resolve) => {
    child.once('error', () => resolve({ code: 1, failed: true }));
    child.once('exit', (code) => resolve({ code: code ?? 1, failed: false }));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The lab MCP driver timed out.')), timeoutMs);
  });
  const read = async (stream: Readable | null, keep: boolean): Promise<string> => {
    if (!stream) throw new Error('The lab MCP evidence pipe is unavailable.');
    const decoder = new TextDecoder();
    let bytes = 0, output = '';
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > LAB_MCP_MAX_OUTPUT) throw new Error('The lab MCP driver exceeded its bounded output.');
      if (keep) output += decoder.decode(chunk, { stream: true });
    }
    return output + (keep ? decoder.decode() : '');
  };
  try {
    const [output, , result] = await Promise.race([Promise.all([read(child.stdout, true), read(child.stderr, false), exited]), deadline]);
    if (result.failed || result.code !== 0) throw new Error('The lab MCP command failed; remote output is withheld.');
    return output;
  } catch (error) {
    if (!child.pid) throw new Error('The lab MCP command could not launch; remote output is withheld.');
    throw error;
  } finally {
    clearTimeout(timer);
    if (child.pid && processGroup) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : null;
        const alreadyExited = process.platform === 'darwin' && code === 'EPERM'
          && await Promise.race([exited.then(() => true), Bun.sleep(100).then(() => false)]);
        if (code !== 'ESRCH' && !alreadyExited) throw error;
      }
    } else if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdout?.destroy(); child.stderr?.destroy();
    await exited;
  }
}
