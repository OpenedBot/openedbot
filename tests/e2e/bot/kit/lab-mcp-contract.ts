export const LAB_MCP_MAX_OUTPUT = 32_768;
export const LAB_MCP_ACTIONS = ['setup', 'online', 'offline', 'receipts', 'remove'] as const;
export type LabMcpAction = typeof LAB_MCP_ACTIONS[number];
export type LabMcpTarget = { runtimeId: string; nonce: string; profile: string };
export type LabMcpCall = { challenge: string; succeeded: boolean };
export type LabMcpProcess = { pid: number; startTicks: string; running: boolean };
export type LabMcpEvidence = LabMcpTarget & {
  schemaVersion: 1; kind: 'mcp-fixture'; action: LabMcpAction;
  serverName: string; toolName: string; online: boolean; installed: boolean; removed: boolean; replayed: boolean;
  calls: LabMcpCall[]; processes: LabMcpProcess[]; starts: number; secret?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function requireLabMcpTarget(target: LabMcpTarget): void {
  if (!UUID.test(target.runtimeId) || !UUID.test(target.nonce) || !/^e2e-[a-z0-9][a-z0-9-]{0,58}$/.test(target.profile)) {
    throw new Error('The lab MCP fixture requires canonical runtime/nonce UUIDs and an owned e2e- profile (maximum 63 characters).');
  }
}

export function labMcpNames(target: LabMcpTarget): { serverName: string; toolName: string } {
  requireLabMcpTarget(target);
  const serverName = `e2e_${target.nonce.replaceAll('-', '')}`;
  return { serverName, toolName: `mcp__${serverName}__read_probe` };
}

/** Only the exact, ownership-bound CLI document may authorize subsequent mutation/cleanup. */
export function parseLabMcpEvidence(output: string, target: LabMcpTarget, action: LabMcpAction): LabMcpEvidence {
  requireLabMcpTarget(target);
  if (new TextEncoder().encode(output).length > LAB_MCP_MAX_OUTPUT) throw new Error('Lab MCP evidence exceeded 32 KiB.');
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error('The lab MCP driver must return one JSON evidence document.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid lab MCP evidence object.');
  const evidence = value as Record<string, unknown>;
  const fields = ['schemaVersion', 'kind', 'action', 'runtimeId', 'nonce', 'profile', 'serverName', 'toolName',
    'online', 'installed', 'removed', 'replayed', 'calls', 'processes', 'starts', ...(action === 'setup' ? ['secret'] : [])];
  const names = labMcpNames(target);
  if (Object.keys(evidence).sort().join(',') !== fields.sort().join(',')
    || evidence.schemaVersion !== 1 || evidence.kind !== 'mcp-fixture' || evidence.action !== action
    || evidence.runtimeId !== target.runtimeId || evidence.nonce !== target.nonce || evidence.profile !== target.profile
    || evidence.serverName !== names.serverName || evidence.toolName !== names.toolName
    || typeof evidence.online !== 'boolean' || typeof evidence.installed !== 'boolean'
    || typeof evidence.removed !== 'boolean' || typeof evidence.replayed !== 'boolean') {
    throw new Error('Lab MCP evidence does not match the exact target, action and owned native server/tool names.');
  }
  if (!Array.isArray(evidence.calls) || evidence.calls.length > 128 || evidence.calls.some((call: unknown) => {
    if (!call || typeof call !== 'object' || Array.isArray(call)) return true;
    const entry = call as Record<string, unknown>;
    return Object.keys(entry).sort().join(',') !== 'challenge,succeeded' || typeof entry.challenge !== 'string'
      || !/^[A-Za-z0-9_-]{1,100}$/.test(entry.challenge) || typeof entry.succeeded !== 'boolean';
  })) throw new Error('Lab MCP receipts are malformed or exceed their bound.');
  if (!Number.isSafeInteger(evidence.starts) || Number(evidence.starts) < 0 || Number(evidence.starts) > 32
    || !Array.isArray(evidence.processes) || evidence.processes.length !== evidence.starts
    || evidence.processes.some((process: unknown) => {
      if (!process || typeof process !== 'object' || Array.isArray(process)) return true;
      const entry = process as Record<string, unknown>;
      return Object.keys(entry).sort().join(',') !== 'pid,running,startTicks' || typeof entry.pid !== 'number'
        || !Number.isSafeInteger(entry.pid) || entry.pid <= 0 || typeof entry.running !== 'boolean'
        || typeof entry.startTicks !== 'string' || !/^[1-9][0-9]{0,23}$/.test(entry.startTicks);
    }) || new Set(evidence.processes.map((process: LabMcpProcess) => `${process.pid}:${process.startTicks}`)).size !== evidence.starts) {
    throw new Error('Lab MCP native process identities are malformed, duplicated or unbounded.');
  }
  if (action === 'setup' && (typeof evidence.secret !== 'string' || !/^MCP_[a-f0-9]{32}$/.test(evidence.secret)
    || !evidence.installed || evidence.removed || !evidence.online)) throw new Error('Lab MCP setup did not prove the installed online fixture and its private probe.');
  if (evidence.removed && (evidence.installed || evidence.online) || evidence.online && !evidence.installed
    || evidence.removed && evidence.processes.some((process: LabMcpProcess) => process.running)
    || action === 'remove' && (!evidence.removed || evidence.installed || evidence.online)
    || action === 'online' && (!evidence.installed || evidence.removed || !evidence.online)
    || action === 'offline' && (!evidence.installed || evidence.removed || evidence.online)) {
    throw new Error('Lab MCP fixture state contradicts the requested action.');
  }
  return evidence as LabMcpEvidence;
}
