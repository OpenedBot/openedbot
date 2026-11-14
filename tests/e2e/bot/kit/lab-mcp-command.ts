import { LAB_MCP_ACTIONS, parseLabMcpEvidence, requireLabMcpTarget, type LabMcpAction, type LabMcpEvidence, type LabMcpTarget } from './lab-mcp-contract';
import { labMcpProcessEnv, runLabMcpProcess } from './lab-mcp-process';

export type LabMcpCommand = (action: LabMcpAction) => Promise<LabMcpEvidence>;

export async function executeLabMcpCommand(argv: string[], target: LabMcpTarget, action: LabMcpAction, timeoutMs: number): Promise<LabMcpEvidence> {
  requireLabMcpTarget(target);
  if (!LAB_MCP_ACTIONS.includes(action) || !argv.length) throw new Error('An explicit lab MCP fixture command and action are required.');
  const output = await runLabMcpProcess(argv[0]!, argv.slice(1), {
    ...labMcpProcessEnv(process.env), E2E_ALLOW_LAB_FIXTURES: '1', E2E_MCP_ACTION: action,
    E2E_MCP_RUNTIME_ID: target.runtimeId, E2E_MCP_NONCE: target.nonce, E2E_MCP_PROFILE: target.profile,
  }, timeoutMs);
  return parseLabMcpEvidence(output, target, action);
}
