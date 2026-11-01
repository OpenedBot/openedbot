import {
  BOT_TOOL_POLICY_NATIVE_TOOLS,
  isBotToolPolicyKey,
  type BotMcpServerDto,
  type BotToolPolicyDto,
  type BotToolPolicyValue,
} from "@openedbot/contracts-api";

export type ToolPolicyRow = { toolKey: string; label: string; native: boolean; policy: BotToolPolicyValue };
export type ToolPolicyGroup =
  | { kind: "native"; rows: ToolPolicyRow[] }
  | { kind: "mcp"; server: string; rows: ToolPolicyRow[] }
  | { kind: "other"; rows: ToolPolicyRow[] };

/**
 * The PERM2-5 table: the gated native writes, then each MCP server with the
 * tools its inventory discovered, then any stored key neither lists (a
 * server gone, a tool renamed) so it can still be returned to the mode.
 * Families the plugin does not gate (reads, ordinary terminal) get no row.
 */
export function toolPolicyGroups(policies: readonly BotToolPolicyDto[], mcpServers: readonly BotMcpServerDto[] | null): ToolPolicyGroup[] {
  const stored = new Map(policies.map((entry) => [entry.toolKey, entry.policy] as const));
  const listed = new Set<string>();
  const row = (toolKey: string, label: string, native: boolean): ToolPolicyRow => {
    listed.add(toolKey);
    return { toolKey, label, native, policy: stored.get(toolKey) ?? "inherit" };
  };
  const groups: ToolPolicyGroup[] = [
    { kind: "native", rows: BOT_TOOL_POLICY_NATIVE_TOOLS.map((tool) => row(tool, tool, true)) },
  ];
  for (const server of [...(mcpServers ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
    const tools = [...new Set(server.tools ?? [])].sort((a, b) => a.localeCompare(b));
    groups.push({
      kind: "mcp",
      server: server.name,
      rows: tools.map((tool) => `mcp:${server.name}:${tool}`).filter(isBotToolPolicyKey).map((key) => row(key, key.split(":").slice(2).join(":"), false)),
    });
  }
  const others = policies.filter((entry) => !listed.has(entry.toolKey)).map((entry) => row(entry.toolKey, entry.toolKey, false));
  if (others.length > 0) groups.push({ kind: "other", rows: others });
  return groups;
}
