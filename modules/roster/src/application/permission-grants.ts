/**
 * The "always for this tool on this bot" grants as other packages see them
 * (ADR 0001 S4): the API writes and lists them, the core permission source
 * reads one. The permission gate itself never imports this file: it reads
 * grants through the `PermissionRuleSource` port (dependency-cruiser rule
 * `porte-permissions-par-le-port`).
 */
export {
  activeGrantIdTx,
  createBotPermissionGrantTx,
  listActiveBotPermissionGrants,
  revokeBotPermissionGrantTx,
  type BotPermissionGrantRow,
  type PermissionActor,
} from "../sql/permission-grants";
