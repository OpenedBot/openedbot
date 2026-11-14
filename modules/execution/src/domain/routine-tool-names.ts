/**
 * The names of `routine_manage` and its MCP server, with no dependency: the
 * console's first-load chunk imports them without the tool's schema,
 * description or scheduling code.
 */

/** Nom du serveur MCP sur l'hôte : un par runtime, jamais un par bot. */
export const ROUTINE_TOOL_SERVER = "openedbot_routines";
export const ROUTINE_TOOL_NAME = "routine_manage";
/** Le nom que Hermes donne à l'outil dans un run (`mcp__<serveur>__<outil>` depuis Hermes 0.23). */
export const ROUTINE_TOOL_RUNTIME_NAME = `mcp__${ROUTINE_TOOL_SERVER}__${ROUTINE_TOOL_NAME}`;
/** The tool key of its approval gates (`gate-identity.ts`). */
export const ROUTINE_TOOL_KEY = `mcp:${ROUTINE_TOOL_SERVER}:${ROUTINE_TOOL_NAME}`;
/**
 * MCP server names only openedbot's own install path may give (`openedbot_routines`,
 * `openedbot_bot_settings`): an operator's server under one of them would
 * receive the platform's run keys and its ungated reads.
 */
export const RESERVED_MCP_SERVER_PREFIX = "openedbot_";

export function isReservedMcpServerName(name: string): boolean {
  return name.toLowerCase().startsWith(RESERVED_MCP_SERVER_PREFIX);
}
