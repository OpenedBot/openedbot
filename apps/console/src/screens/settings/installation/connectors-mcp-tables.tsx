import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@openedbot/browser-ui-kit";
import type {
  RuntimeIntegrationMcpCatalogEntryDto,
  RuntimeIntegrationMcpServerDto,
} from "@openedbot/contracts-api";
import { useT } from "../../../lib/i18n";
import { BUTTON, ToneBadge } from "../../../components/settings/primitives";
import { serverState } from "./connectors-mcp-shared";

/** Le tableau des serveurs configurés, desktop seulement. */
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
  // Le retrait se confirme ICI, pas chez l'appelant : le téléphone pose sa
  // propre alerte dans la feuille du serveur, et une boîte système du
  // navigateur n'y aurait pas sa place.
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
              {/* L'état porte la nuance, pas seulement une pastille verte :
                  « enregistré », « joignable » et « autorisé » ne sont pas le
                  même fait. */}
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

/** Le tableau du catalogue approuvé, desktop seulement. */
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
                  // Une entrée sans variable s'installe d'un clic ; une entrée
                  // qui en demande ouvre la boîte de saisie. Ouvrir une boîte
                  // vide pour faire confirmer un geste déjà explicite serait un
                  // clic de plus sans information de plus.
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
