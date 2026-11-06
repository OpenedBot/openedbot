/** The runtime's permission settings (terminal danger always) as the API and the core permission source read and write them (ADR 0001 S4). The permission gate itself reads them through the `PermissionRuleSource` port. */
export {
  activeRuntimeIdTx,
  readRuntimePermissionSettingsTx,
  readTerminalAlwaysTx,
  type RuntimePermissionSettingsRow,
  setTerminalDangerAlwaysTx,
} from "../sql/permission-settings";
