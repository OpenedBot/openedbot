import { labMcpSsh } from './lab-mcp-driver';
import { labMcpProcessEnv, runLabMcpProcess, type LabMcpStart } from './kit/lab-mcp-process';
import { BROWSER_ACTIONS, parseBrowserEvidence, type BrowserAction, type BrowserEvidence } from './kit/lab-browser-fixture';
import type { LabMcpTarget } from './kit/lab-mcp-contract';

export function browserSsh(argv: string[], env: Record<string, string | undefined>) {
  const action = env.E2E_BROWSER_ACTION as BrowserAction;
  if (!BROWSER_ACTIONS.includes(action)) throw new Error('Unsupported browser fixture action.');
  // Reuse the strict SSH host/connector/identity validation without invoking MCP.
  const validated = labMcpSsh(argv, { ...env, E2E_MCP_ACTION: action,
    E2E_MCP_RUNTIME_ID: env.E2E_BROWSER_RUNTIME_ID, E2E_MCP_NONCE: env.E2E_BROWSER_NONCE, E2E_MCP_PROFILE: env.E2E_BROWSER_PROFILE });
  if (validated.argv[15] !== 'mcp-fixture') throw new Error('Guarded SSH command structure changed.');
  const remote = validated.argv.with(15, 'browser-fixture');
  // An older CLI rejects this unknown flag before touching any profile.
  remote.splice(remote.length - 1, 0, '--schema-version', '2');
  return { ...validated, action, argv: remote };
}
export async function executeBrowserSsh(command: { argv: string[]; env: Record<string,string>; target: LabMcpTarget; action: BrowserAction }, start?: LabMcpStart): Promise<BrowserEvidence> {
  const output = await runLabMcpProcess('ssh', command.argv, labMcpProcessEnv(command.env), command.action === 'setup' ? 330_000 : 90_000, false, start, 360_000);
  return parseBrowserEvidence(output, command.target, command.action);
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await executeBrowserSsh(browserSsh(Bun.argv.slice(2), process.env)))); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Browser fixture failed.'); process.exitCode = 1; }
}
