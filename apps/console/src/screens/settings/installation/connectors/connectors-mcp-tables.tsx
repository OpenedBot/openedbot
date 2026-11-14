import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@openedbot/browser-ui-kit";
import type {
  RuntimeIntegrationMcpCatalogEntryDto,
  RuntimeIntegrationMcpServerDto,
} from "@openedbot/contracts-api";
import { useT } from "../../../../lib/i18n";
import { BUTTON, ToneBadge } from "../../../../components/settings/primitives";
import { serverState } from "./connectors-mcp-shared";

/** The table of configured servers, desktop only. */
export function McpServerTable({
  servers,
  busy,
  oauthEnabled,
  removingName,
  onAuthorize,
  onRemove,
}: {
  servers: readonly RuntimeIntegrationMcpServerDto[];
  busy: boolean;
  oauthEnabled: boolean;
  removingName: string | null;
  onAuthorize: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  const { t, formatNumber } = useT();
  // Removal is confirmed HERE, not at the caller: the phone puts its
  // own alert in the server's sheet, and a browser system
  // box would have no place there.
  const confirmRemove = (name: string) => {
    if (globalThis.confirm?.(t("connectorsSettings.mcpRemoveConfirm", { name })) === false) return;
    onRemove(name);
  };
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[22%]">{t("connectorsSettings.mcpFieldName")}</TableHead>
          <TableHead>{t("connectorsSettings.mcpColumnEndpoint")}</TableHead>
          <TableHead className="w-[14%]">{t("connectorsSettings.mcpColumnTransport")}</TableHead>
          <TableHead className="w-[24%]">{t("connectorsSettings.mcpColumnState")}</TableHead>
          <TableHead className="w-[18%] text-right">{t("connectorsSettings.mcpColumnAction")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {servers.map((server) => {
          const state = serverState(server);
          return (
          <TableRow key={server.name}>
            <TableCell className="font-medium">{server.name}</TableCell>
            <TableCell className="max-w-0">
              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                {server.endpoint ?? server.command ?? "-"}
              </span>
              {server.envKeys.length > 0 ? (
                <span className="block truncate text-xs text-muted-foreground">
                  {t("connectorsSettings.mcpEnvKeys", { keys: server.envKeys.join(", ") })}
                </span>
              ) : null}
            </TableCell>
            <TableCell>
              {server.transport === "stdio"
                ? t("connectorsSettings.mcpTransportStdio")
                : t("connectorsSettings.mcpTransportHttp")}
            </TableCell>
            <TableCell>
              {/* The state carries the nuance, not only a green pill:
                  « enregistré », « joignable » and « autorisé » are not the
                  same fact. */}
              {state.tone === "success" ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <ToneBadge tone="success">{t(`connectorsSettings.${state.key}`)}</ToneBadge>
                  {server.discoveredTools && server.discoveredTools.length > 0 ? (
                    <span className="text-xs leading-5 text-muted-foreground">
                      {t("connectorsSettings.mcpDiscoveredTools", { count: formatNumber(server.discoveredTools.length) })}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className={state.tone === "warning" ? "text-xs leading-5 text-warn-700" : "text-xs leading-5 text-muted-foreground"}>
                  {t(`connectorsSettings.${state.key}`)}
                </span>
              )}
            </TableCell>
            <TableCell className="text-right">
              <span className="inline-flex flex-wrap justify-end gap-2">
                {state.authorizable && oauthEnabled ? (
                  <button type="button" className={BUTTON.primary} disabled={busy} onClick={() => onAuthorize(server.name)}>
                    {t("connectorsSettings.mcpOauthAuthorize")}
                  </button>
                ) : null}
                <button type="button" className={BUTTON.secondary} disabled={busy} onClick={() => confirmRemove(server.name)}>
                  {removingName === server.name
                    ? t("connectorsSettings.mcpRemoving")
                    : t("connectorsSettings.mcpRemove")}
                </button>
              </span>
            </TableCell>
          </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** The approved-catalog table, desktop only. */
export function McpCatalogTable({
  catalog,
  installed,
  busy,
  installingName,
  onOpen,
  onInstall,
}: {
  catalog: readonly RuntimeIntegrationMcpCatalogEntryDto[];
  installed: Set<string>;
  busy: boolean;
  installingName: string | null;
  onOpen: (entry: RuntimeIntegrationMcpCatalogEntryDto) => void;
  onInstall: (name: string, env: Record<string, string>) => void;
}) {
  const { t, formatNumber } = useT();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[18%]">{t("connectorsSettings.mcpFieldName")}</TableHead>
          <TableHead>{t("connectorsSettings.mcpColumnDescription")}</TableHead>
          <TableHead className="w-[20%]">{t("connectorsSettings.mcpColumnState")}</TableHead>
          <TableHead className="w-[12%] text-right">{t("connectorsSettings.mcpColumnAction")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {catalog.map((entry) => {
          const isInstalled = installed.has(entry.name);
          const needsEnv = entry.envSpecs.length > 0;
          return (
            <TableRow key={entry.name}>
              <TableCell className="font-medium">{entry.name}</TableCell>
              <TableCell className="max-w-0">
                <span className="block truncate text-sm text-muted-foreground">
                  {entry.description || t("connectorsSettings.noDescription")}
                </span>
              </TableCell>
              <TableCell>
                {isInstalled ? (
                  <ToneBadge tone="success">{t("connectorsSettings.mcpInstalled")}</ToneBadge>
                ) : needsEnv ? (
                  <span className="text-xs leading-5 text-muted-foreground">
                    {t("connectorsSettings.mcpCatalogNeedsEnv", {
                      count: formatNumber(entry.envSpecs.length),
                    })}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="text-right">
                <button
                  type="button"
                  className={BUTTON.secondary}
                  disabled={busy || isInstalled}
                  // An entry with no variable installs in one click; an entry
                  // that asks for one opens the input box. Opening an empty
                  // box to confirm a gesture that is already explicit would be one
                  // more click with no more information.
                  onClick={() => (needsEnv ? onOpen(entry) : onInstall(entry.name, {}))}
                >
                  {installingName === entry.name
                    ? t("connectorsSettings.mcpInstalling")
                    : t("connectorsSettings.mcpInstall")}
                </button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
