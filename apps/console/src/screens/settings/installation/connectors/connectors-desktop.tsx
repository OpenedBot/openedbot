import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { IconPlus, IconSearch } from "@tabler/icons-react";
import { Input, cn } from "@openedbot/browser-ui-kit";
import type {
  RuntimeIntegrationInventoryDto,
  RuntimeIntegrationMcpDto,
} from "@openedbot/contracts-api";
import { MCP_CONNECTOR_CATALOG, type McpConnectorEntry } from "@openedbot/runtimes/domain/mcp-connector-catalog";
import { api, errorMessage, queryKeys } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { BUTTON, CARD_TITLE, Note, SETTINGS_PANEL, SETTINGS_SHELL, SETTINGS_SHELL_HEADER, SectionHeading } from "../../../../components/settings/primitives";
import {
  CONNECTOR_PILL,
  McpConnectorLogo,
  McpConnectorRow,
  McpConnectorSection,
} from "../../../../components/mcp-connector-row";
import { SettingsPane } from "../../pane";
import { McpAddDialog, type AddInput } from "./connectors-mcp-dialogs";
import { McpOauthDialog } from "./connectors-mcp-oauth";
import { invalidateMcpConnectionReads, serverState } from "./connectors-mcp-shared";
import { ConnectorAddedNotice, useConnectorAdd } from "./connectors-bot-picker";
import { ConnectorManageDialog } from "./connectors-manage-dialog";
import {
  CATEGORY_LABEL,
  botLinksToAuthorize,
  catalogConnections,
  catalogEntryOfServer,
  catalogSections,
  connectedBotLinks,
  type ConnectorConnection,
  connectorDescriptionKey,
  isListedConnection,
  matchesQuery,
} from "./connectors-catalog-model";
import { InventoryAlerts, McpDialog } from "./connectors-parts";
import { SkillsTab } from "./connectors-skills";
import { ToolsTab } from "./connectors-tools";

type Tab = "connectors" | "skills" | "tools";
const TABS: readonly Tab[] = ["connectors", "skills", "tools"];

/**
 * Settings › Connectors on desktop: one large panel, three sections at the
 * top left (Connecteurs | Compétences | Outils), the search and
 * « Nouveau connecteur » at the top right, then row sections on
 * two columns (logo, name, one description line, the gesture).
 *
 * « Ajouter » connects nothing to the host's root: an MCP token lives in
 * a bot's profile, so the box asks « à quel bot ? » then plays the flow
 * of that bot's MCP panel. Host administration (servers, Hermes's
 * approved catalog, root authorization, gateway restart) stays
 * whole behind « Catalogue de l'hôte ».
 */
export function ConnectorsDesktop({
  data,
  refreshButton,
}: {
  data: RuntimeIntegrationInventoryDto;
  refreshButton: ReactNode;
}) {
  const { t, formatDate } = useT();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("connectors");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const connect = useConnectorAdd();
  const canMcp = data.management.capabilities.mcp;
  const tabsId = useId();

  const invalidateMcp = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeMcp });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeIntegrations });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeGateway });
  };
  const add = useMutation({
    mutationFn: (input: AddInput) => api.addRuntimeMcpServer(input),
    onSuccess: () => { setFailure(null); invalidateMcp(); },
    onError: (error) => setFailure(errorMessage(error, t("connectorsSettings.loadError"))),
  });

  const labels: Record<Tab, string> = {
    connectors: t("connectorsPage.tabConnectors"),
    skills: t("connectorsPage.tabSkills"),
    tools: t("connectorsPage.tabTools"),
  };

  return (
    <SettingsPane>
      <SectionHeading
        title={t("connectorsSettings.title")}
        description={t("connectorsSettings.description")}
        action={refreshButton}
      />
      <InventoryAlerts data={data} />

      <div data-connectors-layout="desktop-catalog" className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ConnectorTabs
            idPrefix={tabsId}
            value={tab}
            labels={labels}
            onChange={(next) => {
              setTab(next);
              setQuery("");
            }}
          />
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <div className="relative w-full max-w-64">
              <IconSearch
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                className="h-9 rounded-full pl-8"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("connectorsPage.search")}
                aria-label={t("connectorsPage.searchLabel")}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <button
              type="button"
              className={cn(BUTTON.primary, "shrink-0 gap-1.5 rounded-full")}
              disabled={!canMcp || add.isPending}
              onClick={() => setAdding(true)}
            >
              <IconPlus aria-hidden className="size-4" />
              {t("connectorsPage.newConnector")}
            </button>
          </div>
        </div>

        <div
          role="tabpanel"
          id={`${tabsId}-panel`}
          aria-labelledby={`${tabsId}-${tab}`}
          className="space-y-8"
        >
          {tab === "connectors" ? (
            <ConnectorsTab
              data={data}
              query={query}
              connect={connect}
              failure={failure}
              onRestarted={invalidateMcp}
            />
          ) : tab === "skills" ? (
            <SkillsTab data={data} query={query} />
          ) : (
            <ToolsTab data={data} query={query} />
          )}
        </div>
      </div>

      <p className="text-xs leading-5 text-muted-foreground">
        {t("connectorsSettings.configuredSignalNote")}
        {" · "}
        {t("connectorsSettings.observedAt", {
          date: formatDate(data.observedAt, { dateStyle: "medium", timeStyle: "short" }),
        })}
      </p>

      <McpAddDialog
        open={adding}
        busy={add.isPending}
        pending={add.isPending}
        onClose={() => setAdding(false)}
        onSubmit={(input) => {
          add.mutate(input);
          setAdding(false);
          setTab("connectors");
        }}
      />
      {connect.elements}
    </SettingsPane>
  );
}

/** The sections: text tabs, the left/right arrow moves from one to the other. */
function ConnectorTabs({
  idPrefix,
  value,
  labels,
  onChange,
}: {
  idPrefix: string;
  value: Tab;
  labels: Record<Tab, string>;
  onChange: (tab: Tab) => void;
}) {
  const { t } = useT();
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(value) + step + TABS.length) % TABS.length]!;
    onChange(next);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={t("connectorsPage.tabsLabel")} className="flex items-center gap-1" onKeyDown={onKeyDown}>
      {TABS.map((tab) => {
        const selected = tab === value;
        return (
          <button
            key={tab}
            ref={(node) => { refs.current[tab] = node; }}
            type="button"
            role="tab"
            id={`${idPrefix}-${tab}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab)}
            className={cn(
              "h-8 cursor-pointer rounded-full px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              selected ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {labels[tab]}
          </button>
        );
      })}
    </div>
  );
}

function ConnectorsTab({
  data,
  query,
  connect,
  failure,
  onRestarted,
}: {
  data: RuntimeIntegrationInventoryDto;
  query: string;
  connect: ReturnType<typeof useConnectorAdd>;
  failure: string | null;
  onRestarted: () => void;
}) {
  const { t } = useT();
  const [hostOpen, setHostOpen] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const canMcp = data.management.capabilities.mcp;
  // The API's snapshot, not the proven reread (`?fresh=1`): that one
  // starts an interpreter on the host on EVERY display (2 to 3 s when the
  // operator's cache has expired) and held « Connectés » on
  // « Chargement… ». The API invalidates the snapshot on every MCP write and at the
  // end of an authorization; the host's panel, same key, rereads live
  // when it opens.
  const mcp = useQuery({ queryKey: queryKeys.runtimeMcp, queryFn: api.runtimeMcp, enabled: canMcp });
  // A bot's connections live in its profile's configuration.
  const profiles = useQuery({ queryKey: queryKeys.runtimeProfiles, queryFn: api.runtimeProfiles });
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster });
  const describe = (entry: McpConnectorEntry) => {
    const key = connectorDescriptionKey(entry.id);
    return key ? t(key) : "";
  };
  const connections = catalogConnections({
    catalog: MCP_CONNECTOR_CATALOG,
    profiles: profiles.data?.profiles ?? null,
    bots: roster.data?.bots ?? null,
    rootServers: mcp.data?.available ? mcp.data.servers : null,
  });
  // Carried without a token is not connected: such an entry stays offered.
  const listed = connections.filter(isListedConnection);
  const connectedIds = new Set(listed.map((connection) => connection.entry.id));
  // Which bot carries what is read from the profiles. Unread, « Connectés »
  // says it is unknown, never « none »; the catalog stays offered: « Ajouter »
  // asks for a bot, and choosing one that already carries the entry only
  // reauthorizes it.
  const sections = catalogSections(MCP_CONNECTOR_CATALOG, describe, query, connectedIds);
  const managed = connections.find((connection) => connection.entry.id === managing) ?? null;
  const managedEntry = managing ? MCP_CONNECTOR_CATALOG.find((entry) => entry.id === managing) ?? null : null;
  const blockerReason = connect.blocker === "role"
    ? t("mcpCatalog.unavailableRole")
    : connect.blocker === "host"
      ? t("mcpCatalog.unavailableHost")
      : null;
  const addDisabled = !connect.ready || connect.blocker !== null || connect.busy;

  return (
    <>
      {failure ? <Note tone="danger" role="alert">{failure}</Note> : null}
      <ConnectorAddedNotice add={connect} onRestarted={onRestarted} />
      {canMcp ? null : (
        // Without MCP administration, « Nouveau connecteur » is greyed out: the page says why.
        <Note tone="neutral">{t("connectorsPage.managementUnavailable")}</Note>
      )}
      <ConnectedSection
        query={query}
        mcp={canMcp ? mcp : null}
        connectionsPending={profiles.isPending || roster.isPending}
        connectionsError={profiles.isError}
        onRetryConnections={() => void profiles.refetch()}
        connections={listed}
        describe={describe}
        onManage={(connection) => setManaging(connection.entry.id)}
      />
      {blockerReason ? <Note tone="warning">{blockerReason}</Note> : null}
      {sections.map((section) => (
        <McpConnectorSection
          key={section.key}
          id={`connectors-section-${section.key}`}
          title={section.key === "featured" ? t("connectorsPage.sectionFeatured") : t(CATEGORY_LABEL[section.key])}
        >
          {section.entries.map((entry) => (
            <McpConnectorRow
              key={entry.id}
              logo={<McpConnectorLogo id={entry.id} name={entry.name} />}
              name={entry.name}
              description={describe(entry) || undefined}
              caption={toAuthorizeCaption(connections, entry.id, t)}
              action={
                <button
                  type="button"
                  className={CONNECTOR_PILL}
                  aria-label={t("connectorsPage.addAria", { name: entry.name })}
                  disabled={addDisabled}
                  onClick={() => connect.add(entry, ...pickerMarksOf(connections, entry.id))}
                >
                  {t("connectorsPage.add")}
                </button>
              }
            />
          ))}
        </McpConnectorSection>
      ))}
      {sections.length === 0 && query.trim() !== "" ? (
        <p className="text-sm text-muted-foreground">{t("connectorsPage.noMatch", { query: query.trim() })}</p>
      ) : null}

      <section aria-labelledby="connectors-section-host" className={SETTINGS_SHELL}>
        <div className={SETTINGS_SHELL_HEADER}>
          <h3 id="connectors-section-host" className={CARD_TITLE}>{t("connectorsPage.sectionHostCatalog")}</h3>
        </div>
        <div className={cn(SETTINGS_PANEL, "flex flex-wrap items-center justify-between gap-3 px-4 py-3")}>
          <p className="min-w-0 flex-1 basis-64 text-xs leading-5 text-muted-foreground">{t("connectorsPage.hostCatalogDescription")}</p>
          <button type="button" aria-haspopup="dialog" className={BUTTON.secondary} onClick={() => setHostOpen(true)}>
            {t("connectorsPage.hostCatalogOpen")}
          </button>
        </div>
      </section>
      <McpDialog open={hostOpen} onClose={() => setHostOpen(false)} inventory={data} />
      <ConnectorManageDialog
        open={managing !== null}
        connection={managed}
        onClose={() => setManaging(null)}
        blocker={connect.disconnectBlocker}
        canRemoveRoot={canMcp}
        gatewayRestart={connect.gatewayRestart}
        liveReload={connect.liveReload}
        connectDisabled={addDisabled}
        onConnectBot={() => {
          if (managedEntry) connect.add(managedEntry, ...pickerMarksOf(connections, managedEntry.id));
        }}
        onAuthorizeBot={(botId) => {
          const bot = roster.data?.bots.find((candidate) => candidate.id === botId);
          if (managedEntry && bot) connect.authorize(managedEntry, bot);
        }}
      />
    </>
  );
}

/** The bots the picker marks for this entry: connected ones, then those to authorize. */
function pickerMarksOf(connections: readonly ConnectorConnection[], id: string): [string[], string[]] {
  const connection = connections.find((candidate) => candidate.entry.id === id);
  if (!connection) return [[], []];
  return [connectedBotLinks(connection).map((link) => link.botId), botLinksToAuthorize(connection).map((link) => link.botId)];
}

/**
 * An entry offered in the catalog that bots carry without a token: the row
 * says so, and « Ajouter » marks those bots « à autoriser ».
 */
function toAuthorizeCaption(
  connections: readonly ConnectorConnection[],
  id: string,
  t: ReturnType<typeof useT>["t"],
): string | undefined {
  const connection = connections.find((candidate) => candidate.entry.id === id);
  const bots = connection ? botLinksToAuthorize(connection) : [];
  return bots.length > 0 ? t("connectorsPage.toAuthorizeCaption", { bots: bots.map((link) => link.name).join(", ") }) : undefined;
}

/**
 * « Connectés »: one row per catalog entry a bot carries (or whose
 * root keeps a token), then the servers added by hand on the host.
 * « Gérer » opens the connected bots and their « Déconnecter ». A connected
 * entry does not come back in « À la une » nor in its category.
 */
function ConnectedSection({
  query,
  mcp,
  connectionsPending,
  connectionsError,
  onRetryConnections,
  connections,
  describe,
  onManage,
}: {
  query: string;
  /** `null`: the host does not expose MCP administration. */
  mcp: UseQueryResult<RuntimeIntegrationMcpDto> | null;
  connectionsPending: boolean;
  /** The bots' connections could not be read: unknown, never « none ». */
  connectionsError: boolean;
  onRetryConnections: () => void;
  connections: ConnectorConnection[];
  describe: (entry: McpConnectorEntry) => string;
  onManage: (connection: ConnectorConnection) => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [oauthServer, setOauthServer] = useState<string | null>(null);
  const invalidate = () => invalidateMcpConnectionReads(queryClient);

  const catalogRows = connections
    .filter((connection) => matchesQuery({ name: connection.entry.name, description: describe(connection.entry) }, query))
    .map((connection) => {
      const connected = connectedBotLinks(connection);
      const toAuthorize = botLinksToAuthorize(connection);
      return (
        <McpConnectorRow
          key={`catalog:${connection.entry.id}`}
          logo={<McpConnectorLogo id={connection.entry.id} name={connection.entry.name} />}
          name={connection.entry.name}
          description={
            connected.length > 0
              ? t("connectorsPage.connectedTo", { bots: connected.map((link) => link.name).join(", ") })
              : t("connectorsPage.rootOnlyCaption")
          }
          caption={toAuthorize.length > 0
            ? t("connectorsPage.toAuthorizeCaption", { bots: toAuthorize.map((link) => link.name).join(", ") })
            : undefined}
          action={
            <button
              type="button"
              className={CONNECTOR_PILL}
              aria-label={t("connectorsPage.manageAria", { name: connection.entry.name })}
              onClick={() => onManage(connection)}
            >
              {t("connectorsPage.manage")}
            </button>
          }
        />
      );
    });

  // The servers added by hand: neither a bot nor the catalog, they live at the root.
  const oauth = mcp?.data?.available ? mcp.data.capabilities.oauth : false;
  const customRows = (mcp?.data?.available ? mcp.data.servers : [])
    .filter((server) => catalogEntryOfServer(server) === null)
    .filter((server) => matchesQuery({ name: server.name, description: server.endpoint ?? server.command ?? "" }, query))
    .map((server) => {
      const state = serverState(server);
      const authorize = state.authorizable && oauth;
      return (
        <McpConnectorRow
          key={`server:${server.name}`}
          logo={<McpConnectorLogo id={`server:${server.name}`} name={server.name} />}
          name={server.name}
          description={server.endpoint ?? server.command ?? undefined}
          caption={
            authorize
              ? t("connectorsPage.customOauthCaption")
              : state.tone === "warning"
                ? t(`connectorsSettings.${state.key}`)
                : undefined
          }
          action={
            authorize ? (
              <button type="button" className={CONNECTOR_PILL} onClick={() => setOauthServer(server.name)}>
                {t("connectorsSettings.mcpOauthAuthorize")}
              </button>
            ) : (
              <span className="text-xs text-muted-foreground">{t("connectorsPage.configuredOnHost")}</span>
            )
          }
        />
      );
    });

  const rows = [...catalogRows, ...customRows];
  const pending = connectionsPending || (mcp?.isPending ?? false);
  let status: ReactNode = null;
  if (connectionsError) status = <Note tone="danger" role="alert">{t("connectorsPage.connectionsLoadError")}</Note>;
  else if (mcp?.isError) status = <Note tone="danger" role="alert">{t("connectorsPage.connectedLoadError")}</Note>;
  else if (mcp?.data && !mcp.data.available) status = <Note tone="warning">{t("connectorsSettings.mcpUnavailable")}</Note>;

  if (rows.length === 0 && !pending && !status && query.trim() !== "") return null;

  return (
    <>
      <McpConnectorSection
        id="connectors-section-connected"
        title={t("connectorsPage.sectionConnected")}
        footer={status}
        action={connectionsError ? (
          <button type="button" className={BUTTON.secondary} onClick={onRetryConnections}>{t("connectorsSettings.retry")}</button>
        ) : undefined}
      >
        {rows.length > 0
          ? rows
          : connectionsError
            ? null
            : (
              <li className="col-span-full py-3 text-sm text-muted-foreground">
                {pending ? t("common.loading") : t("connectorsPage.connectedEmpty")}
              </li>
            )}
      </McpConnectorSection>
      <McpOauthDialog server={oauthServer} onClose={() => setOauthServer(null)} onConnected={invalidate} />
    </>
  );
}
