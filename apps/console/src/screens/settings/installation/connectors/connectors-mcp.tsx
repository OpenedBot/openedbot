import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconPlus, IconSearch } from "@tabler/icons-react";
import { Input, useIsMobile } from "@openedbot/browser-ui-kit";
import type { RuntimeIntegrationMcpCatalogEntryDto, RuntimeIntegrationMcpDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { BUTTON, Note, SettingsCard } from "../../../../components/settings/primitives";
import {
  InsetGroupedRow,
  InsetGroupedSection,
  InsetGroupedStatic,
} from "../../../../components/mobile/inset-grouped";
import { filterCatalog } from "./connectors-mcp-shared";
import { McpCatalogTable, McpServerTable } from "./connectors-mcp-tables";
import { McpActionRow, McpCatalogSheet, McpServerListRow, McpServerSheet } from "./connectors-mcp-mobile";
import { McpOauthDialog } from "./connectors-mcp-oauth";
import { GatewayRestartCard } from "./connectors-mcp-gateway";
import { McpAddDialog, McpInstallDialog, type AddInput } from "./connectors-mcp-dialogs";

export { filterCatalog } from "./connectors-mcp-shared";
export { McpOauthDialog } from "./connectors-mcp-oauth";
export { GatewayRestartCard } from "./connectors-mcp-gateway";
export { McpInstallDialog } from "./connectors-mcp-dialogs";

/**
 * Administration of the MCP servers, from openedbot, by the host's operator.
 *
 * This panel exists only if the host has ANNOUNCED `mcp_management`: without it,
 * `available` is `false` and what is missing is said rather than showing a
 * form whose send would fail. No secret ever comes back here: a
 * token leaves for the host and does not come out of it.
 *
 * The form does NOT offer a stdio server: adding a server as a
 * local command means naming an executable and its argv, and the link carries
 * nothing of the sort toward the client's machine. Local-command servers
 * arrive through the approved catalog, whose list the host holds.
 */
export function McpPanel() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  // The server whose OAuth authorization is open, or nothing.
  const [oauthServer, setOauthServer] = useState<string | null>(null);
  // Read HERE and not in the page: this read starts an interpreter on
  // the host, and this component is mounted only when the panel opens.
  const query = useQuery({ queryKey: queryKeys.runtimeMcp, queryFn: api.runtimeMcpFresh });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeMcp });
    // An MCP write also changes what the platform carries: the page's
    // inventory is no longer up to date either, nor the gateway's state, which has just
    // gained a change it has not loaded.
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeIntegrations });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeGateway });
  };
  const onError = (error: unknown) => {
    setFailure(error instanceof Error ? error.message : t("connectorsSettings.loadError"));
  };

  const remove = useMutation({
    mutationFn: (name: string) => api.removeRuntimeMcpServer(name),
    onSuccess: () => { setFailure(null); invalidate(); },
    onError,
  });
  const install = useMutation({
    mutationFn: (entry: { name: string; env: Record<string, string> }) =>
      api.installRuntimeMcpCatalogEntry(entry.name, entry.env),
    onSuccess: () => { setFailure(null); invalidate(); },
    onError,
  });
  const add = useMutation({
    mutationFn: api.addRuntimeMcpServer,
    onSuccess: () => { setFailure(null); invalidate(); },
    onError,
  });

  if (query.isPending) {
    return (
      <SettingsCard className="space-y-3">
        <p className="text-sm font-semibold tracking-tight">{t("connectorsSettings.mcpServersTitle")}</p>
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      </SettingsCard>
    );
  }
  // A failed read proves nothing: it reads neither as « aucun connecteur »,
  // nor as « l'hôte ne sait pas faire ».
  if (query.isError || !query.data) {
    return (
      <SettingsCard className="space-y-3">
        <p className="text-sm font-semibold tracking-tight">{t("connectorsSettings.mcpServersTitle")}</p>
        <Note tone="danger" role="alert">{t("connectorsSettings.loadError")}</Note>
      </SettingsCard>
    );
  }
  const mcp = query.data;
  if (!mcp.available) {
    return (
      <SettingsCard className="space-y-3">
        <p className="text-sm font-semibold tracking-tight">{t("connectorsSettings.mcpServersTitle")}</p>
        <Note tone="warning">{t("connectorsSettings.mcpUnavailable")}</Note>
      </SettingsCard>
    );
  }

  const installed = new Set(mcp.servers.map((server) => server.name));
  const busy = remove.isPending || install.isPending || add.isPending;

  /* The gateway reads its MCP servers only at startup: the card says whether a
     change is waiting for it, and carries the only restart the link knows how to
     do. It exists only if the host announces it.

     On the phone it goes UNDER the lists: the restart is the
     consequence of a change, not the screen's front door, and
     putting it at the head pushed the servers (what the operator comes to read)
     off the first screen. */
  const gateway = mcp.capabilities.gatewayRestart
    ? <GatewayRestartCard onRestarted={invalidate} />
    : null;

  return (
    <>
      {isMobile ? null : gateway}
      <McpPanelView
        mcp={mcp}
        installed={installed}
        busy={busy}
        failure={failure}
        addPending={add.isPending}
        installingName={install.isPending ? (install.variables?.name ?? null) : null}
        removingName={remove.isPending ? (remove.variables ?? null) : null}
        onAdd={(input) => add.mutate(input)}
        onInstall={(name, env) => install.mutate({ name, env })}
        onAuthorize={(name) => setOauthServer(name)}
        /* Confirmation belongs to the VIEW, not to the driver: the desktop
           table keeps the browser's `confirm()`, the phone's detail sheet
           sets its own alert: a grey system box in the middle
           of an installed PWA reads as a web page. */
        onRemove={(name) => remove.mutate(name)}
      />
      {isMobile ? gateway : null}
      <McpOauthDialog server={oauthServer} onClose={() => setOauthServer(null)} onConnected={invalidate} />
    </>
  );
}

/**
 * The view, separated from the mutations so it can be mounted in a test without a network.
 *
 * Two layouts, a single model. On desktop the servers and the catalog
 * are TABLES: twenty catalog entries stacked as cards are read
 * by scrolling, aligned in columns they are compared at a glance.
 *
 * On the phone, neither a table nor cards: two grouped iOS lists. The cards
 * said the real hierarchy backwards: one configured server against
 * twenty-four catalog entries, each in a grey box with its
 * « Installer » button, so the only fact the operator comes to read fit on a
 * sixth of the screen and the rest was a scroll with no filter. The catalog
 * has moved behind ONE row, which opens a searchable sheet.
 *
 * Wiring a server opens a box APART, never a form unfolded in
 * the row: an entry's variables (base URL, API key) are an input
 * of their own, and showing them inline pushes the rest of the catalog off the screen
 * while one types.
 */
export function McpPanelView({
  mcp,
  installed,
  busy,
  failure,
  addPending,
  installingName,
  removingName,
  onAdd,
  onInstall,
  onAuthorize,
  onRemove,
}: {
  mcp: RuntimeIntegrationMcpDto;
  installed: Set<string>;
  busy: boolean;
  failure: string | null;
  addPending: boolean;
  installingName: string | null;
  removingName: string | null;
  onAdd: (input: AddInput) => void;
  onInstall: (name: string, env: Record<string, string>) => void;
  onAuthorize: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  const { t, formatNumber } = useT();
  const isMobile = useIsMobile();
  const [adding, setAdding] = useState(false);
  const oauthEnabled = mcp.capabilities.oauth;
  const [installEntry, setInstallEntry] = useState<RuntimeIntegrationMcpCatalogEntryDto | null>(null);
  // Phone: the catalog's sheet, and the server whose detail is
  // open. A removed server disappears from `mcp.servers`: the sheet then closes
  // by itself, without the removal having to drive it.
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  // The catalog filter, shared by the sheet and the table: twenty-four
  // entries with no search field are browsed, they are not found.
  const [query, setQuery] = useState("");
  const matching = filterCatalog(mcp.catalog, query);
  const detailServer = mcp.servers.find((server) => server.name === detail) ?? null;

  const alerts = (
    <>
      {/* A read's failure and a write's failure are both said,
          and separately: one says « je ne sais pas », the other « ça n'a
          pas eu lieu ». */}
      {mcp.error ? <Note tone="danger" role="alert">{mcp.error.message}</Note> : null}
      {failure ? <Note tone="danger" role="alert">{failure}</Note> : null}
    </>
  );

  const dialogs = (
    <>
      <McpAddDialog
        open={adding}
        busy={busy}
        pending={addPending}
        onClose={() => setAdding(false)}
        onSubmit={(input) => {
          onAdd(input);
          setAdding(false);
        }}
      />
      <McpInstallDialog
        entry={installEntry}
        busy={busy}
        pending={installEntry !== null && installingName === installEntry.name}
        onClose={() => setInstallEntry(null)}
        onSubmit={(env) => {
          if (!installEntry) return;
          onInstall(installEntry.name, env);
          setInstallEntry(null);
          setCatalogOpen(false);
        }}
      />
    </>
  );

  if (isMobile) {
    return (
      <>
        {alerts}

        <InsetGroupedSection
          caption={t("connectorsSettings.mcpServersTitle")}
          footer={t("connectorsSettings.mcpServersDescription")}
        >
          {mcp.servers.length === 0 ? (
            <InsetGroupedStatic label={t("connectorsSettings.mcpNoServerRow")} />
          ) : (
            mcp.servers.map((server) => (
              <McpServerListRow
                key={server.name}
                server={server}
                onOpen={() => setDetail(server.name)}
              />
            ))
          )}
          {/* The add is the LAST ROW of the group, not a button set in
              the card's header: that is where iOS puts « Ajouter un compte »,
              and the screen's bottom bar already carries two CTAs. */}
          <McpActionRow
            icon={IconPlus}
            label={t("connectorsSettings.mcpAddTitle")}
            disabled={busy}
            onClick={() => setAdding(true)}
          />
        </InsetGroupedSection>

        {mcp.catalog.length === 0 ? (
          <p className="px-8 pt-4 text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
            {t("connectorsSettings.mcpCatalogEmpty")}
          </p>
        ) : (
          <InsetGroupedSection footer={t("connectorsSettings.mcpCatalogDescription")}>
            <InsetGroupedRow
              label={t("connectorsSettings.mcpCatalogTitle")}
              value={t("connectorsSettings.mcpCatalogCount", {
                count: formatNumber(mcp.catalog.length),
              })}
              aria-label={t("connectorsSettings.mcpCatalogOpen")}
              disabled={busy}
              onClick={() => {
                setQuery("");
                setCatalogOpen(true);
              }}
            />
          </InsetGroupedSection>
        )}

        <McpServerSheet
          server={detailServer}
          busy={busy}
          oauthEnabled={oauthEnabled}
          removing={removingName === detail}
          onAuthorize={() => {
            if (detail === null) return;
            setDetail(null);
            onAuthorize(detail);
          }}
          onRemove={() => {
            if (detail !== null) onRemove(detail);
          }}
          onClose={() => setDetail(null)}
        />
        <McpCatalogSheet
          open={catalogOpen}
          entries={matching}
          total={mcp.catalog.length}
          installed={installed}
          busy={busy}
          query={query}
          onQuery={setQuery}
          onClose={() => setCatalogOpen(false)}
          onOpen={setInstallEntry}
        />
        {dialogs}
      </>
    );
  }

  return (
    <div className="space-y-4">
      {alerts}

      <SettingsCard className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">{t("connectorsSettings.mcpServersTitle")}</p>
            <p className="text-sm leading-6 text-muted-foreground">
              {t("connectorsSettings.mcpServersDescription")}
            </p>
          </div>
          <button type="button" className={BUTTON.secondary} disabled={busy} onClick={() => setAdding(true)}>
            {t("connectorsSettings.mcpAddTitle")}
          </button>
        </div>
        {mcp.servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("connectorsSettings.mcpServersEmpty")}</p>
        ) : (
          <McpServerTable
            servers={mcp.servers}
            busy={busy}
            oauthEnabled={oauthEnabled}
            removingName={removingName}
            onAuthorize={onAuthorize}
            onRemove={onRemove}
          />
        )}
      </SettingsCard>

      <SettingsCard className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">{t("connectorsSettings.mcpCatalogTitle")}</p>
            <p className="text-sm leading-6 text-muted-foreground">
              {t("connectorsSettings.mcpCatalogDescription")}
            </p>
          </div>
          {/* The same filter as the phone's sheet: twenty-four rows
              sorted by name are browsed as badly with the mouse as with a finger. */}
          {mcp.catalog.length > 0 ? (
            <div className="relative w-full sm:w-64">
              <IconSearch
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                className="pl-8"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("connectorsSettings.mcpCatalogSearch")}
                aria-label={t("connectorsSettings.mcpCatalogSearchLabel")}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          ) : null}
        </div>
        {mcp.catalog.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("connectorsSettings.mcpCatalogEmpty")}</p>
        ) : matching.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("connectorsSettings.mcpCatalogNoMatch", { query: query.trim() })}
          </p>
        ) : (
          <McpCatalogTable
            catalog={matching}
            installed={installed}
            busy={busy}
            installingName={installingName}
            onOpen={setInstallEntry}
            onInstall={onInstall}
          />
        )}
      </SettingsCard>

      {dialogs}
    </div>
  );
}
