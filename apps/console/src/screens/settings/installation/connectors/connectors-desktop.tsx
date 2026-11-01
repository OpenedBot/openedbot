import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { IconPlus, IconSearch } from "@tabler/icons-react";
import { Input, cn } from "@openedbot/browser-ui-kit";
import type {
  BotSkillDto,
  RuntimeIntegrationInventoryDto,
  RuntimeIntegrationMcpDto,
  RuntimeIntegrationToolsetDto,
} from "@openedbot/contracts-api";
import { MCP_CONNECTOR_CATALOG, type McpConnectorEntry } from "@openedbot/runtimes/domain/mcp-connector-catalog";
import { api, errorMessage, queryKeys } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { BUTTON, Note, SETTINGS_PANEL, SectionHeading, ToneBadge } from "../../../../components/settings/primitives";
import {
  CONNECTOR_PILL,
  McpConnectorLogo,
  McpConnectorRow,
  McpConnectorSection,
} from "../../../../components/mcp-connector-row";
import { SettingsPane } from "../../pane";
import { McpAddDialog, type AddInput } from "./connectors-mcp-dialogs";
import { McpOauthDialog } from "./connectors-mcp-oauth";
import { serverState } from "./connectors-mcp-shared";
import { ConnectorAddedNotice, useConnectorAdd } from "./connectors-bot-picker";
import { ConnectorManageDialog } from "./connectors-manage-dialog";
import {
  CATEGORY_LABEL,
  catalogConnections,
  catalogEntryOfServer,
  catalogSections,
  type ConnectorConnection,
  connectorDescriptionKey,
  matchesQuery,
} from "./connectors-catalog-model";
import { InventoryAlerts, McpDialog, SkillDialog, ToolsetDialog, groupSkills, toolsetStatusMap } from "./connectors-parts";

type Tab = "connectors" | "skills" | "tools";
const TABS: readonly Tab[] = ["connectors", "skills", "tools"];

/**
 * Réglages › Connecteurs sur bureau : un grand panneau, trois rubriques en
 * haut à gauche (Connecteurs | Compétences | Outils), la recherche et
 * « Nouveau connecteur » en haut à droite, puis des sections de lignes sur
 * deux colonnes (logo, nom, une ligne de description, le geste).
 *
 * « Ajouter » ne connecte rien à la racine de l'hôte : un jeton MCP vit dans
 * le profil d'un bot, la boîte demande donc « à quel bot ? » puis joue le flux
 * du volet MCP de ce bot. L'administration de l'hôte (serveurs, catalogue
 * approuvé de Hermes, autorisation racine, redémarrage du gateway) reste
 * entière derrière « Catalogue de l'hôte ».
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

/** Les rubriques : des onglets texte, la flèche gauche/droite passe de l'un à l'autre. */
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
  // L'instantané de l'API, pas la relecture prouvée (`?fresh=1`) : celle-ci
  // démarre un interpréteur sur l'hôte à CHAQUE affichage (2 à 3 s quand le
  // cache de l'opérateur a expiré) et retenait « Connectés » sur
  // « Chargement… ». L'API invalide l'instantané à chaque écriture MCP et à la
  // fin d'une autorisation ; le panneau de l'hôte, même clé, relit en direct
  // quand il s'ouvre.
  const mcp = useQuery({ queryKey: queryKeys.runtimeMcp, queryFn: api.runtimeMcp, enabled: canMcp });
  // Les connexions d'un bot vivent dans la configuration de son profil.
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
  const connectedIds = new Set(connections.map((connection) => connection.entry.id));
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
        // Sans administration MCP, « Nouveau connecteur » est grisé : la page dit pourquoi.
        <Note tone="neutral">{t("connectorsPage.managementUnavailable")}</Note>
      )}
      <ConnectedSection
        query={query}
        mcp={canMcp ? mcp : null}
        connectionsPending={profiles.isPending || roster.isPending}
        connections={connections}
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
              action={
                <button
                  type="button"
                  className={CONNECTOR_PILL}
                  aria-label={t("connectorsPage.addAria", { name: entry.name })}
                  disabled={addDisabled}
                  onClick={() => connect.add(entry)}
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

      <section aria-labelledby="connectors-section-host" className="space-y-2">
        <h3 id="connectors-section-host" className="text-sm font-semibold tracking-tight">{t("connectorsPage.sectionHostCatalog")}</h3>
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
          if (managedEntry) connect.add(managedEntry, managed?.bots.map((link) => link.botId) ?? []);
        }}
      />
    </>
  );
}

/**
 * « Connectés » : une ligne par entrée du catalogue qu'un bot porte (ou dont
 * la racine garde un jeton), puis les serveurs ajoutés à la main sur l'hôte.
 * « Gérer » ouvre les bots connectés et leur « Déconnecter ». Une entrée
 * connectée ne revient pas dans « À la une » ni dans sa catégorie.
 */
function ConnectedSection({
  query,
  mcp,
  connectionsPending,
  connections,
  describe,
  onManage,
}: {
  query: string;
  /** `null` : l'hôte n'expose pas l'administration MCP. */
  mcp: UseQueryResult<RuntimeIntegrationMcpDto> | null;
  connectionsPending: boolean;
  connections: ConnectorConnection[];
  describe: (entry: McpConnectorEntry) => string;
  onManage: (connection: ConnectorConnection) => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [oauthServer, setOauthServer] = useState<string | null>(null);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeMcp });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeIntegrations });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeGateway });
  };

  const catalogRows = connections
    .filter((connection) => matchesQuery({ name: connection.entry.name, description: describe(connection.entry) }, query))
    .map((connection) => (
      <McpConnectorRow
        key={`catalog:${connection.entry.id}`}
        logo={<McpConnectorLogo id={connection.entry.id} name={connection.entry.name} />}
        name={connection.entry.name}
        description={
          connection.bots.length > 0
            ? t("connectorsPage.connectedTo", { bots: connection.bots.map((link) => link.name).join(", ") })
            : t("connectorsPage.rootOnlyCaption")
        }
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
    ));

  // Les serveurs ajoutés à la main : ni bot, ni catalogue, ils vivent à la racine.
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
  if (mcp?.isError) status = <Note tone="danger" role="alert">{t("connectorsPage.connectedLoadError")}</Note>;
  else if (mcp?.data && !mcp.data.available) status = <Note tone="warning">{t("connectorsSettings.mcpUnavailable")}</Note>;

  if (rows.length === 0 && !pending && !status && query.trim() !== "") return null;

  return (
    <>
      <McpConnectorSection id="connectors-section-connected" title={t("connectorsPage.sectionConnected")} footer={status}>
        {rows.length > 0
          ? rows
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

function SkillsTab({ data, query }: { data: RuntimeIntegrationInventoryDto; query: string }) {
  const { t } = useT();
  const [selected, setSelected] = useState<BotSkillDto | null>(null);
  if (data.skills === null) {
    return (
      <Note tone={data.skillsError ? "danger" : "neutral"}>
        {t(data.skillsError ? "connectorsSettings.skillsFailed" : "connectorsSettings.skillsUnavailable")}
      </Note>
    );
  }
  const kept = data.skills.filter((skill) => matchesQuery(skill, query));
  const groups = groupSkills(kept);
  return (
    <>
      {data.skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("connectorsSettings.skillsEmpty")}</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("connectorsPage.noMatch", { query: query.trim() })}</p>
      ) : (
        groups.map(([category, entries]) => (
          <McpConnectorSection
            key={category || "uncategorized"}
            id={`connectors-skills-${category || "uncategorized"}`}
            title={category || t("connectorsSettings.uncategorized")}
          >
            {entries.map((skill) => (
              <McpConnectorRow
                key={skill.name}
                logo={<McpConnectorLogo id={`skill:${skill.name}`} name={skill.name} />}
                name={skill.name}
                description={skill.description ?? undefined}
                onOpen={() => setSelected(skill)}
              />
            ))}
          </McpConnectorSection>
        ))
      )}
      <SkillDialog skill={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function ToolsTab({ data, query }: { data: RuntimeIntegrationInventoryDto; query: string }) {
  const { t } = useT();
  const [selected, setSelected] = useState<RuntimeIntegrationToolsetDto | null>(null);
  const status = toolsetStatusMap(t);
  const toolsets = data.toolsets ?? [];
  const kept = toolsets.filter((toolset) =>
    matchesQuery({ name: toolset.label, description: `${toolset.name} ${toolset.description ?? ""}` }, query));
  return (
    <>
      {toolsets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {data.toolsets === null ? t("connectorsPage.toolsEmpty") : t("connectorsSettings.runtimeEmpty")}
        </p>
      ) : kept.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("connectorsPage.noMatch", { query: query.trim() })}</p>
      ) : (
        <McpConnectorSection
          id="connectors-tools"
          title={t("connectorsSettings.runtimeTitle")}
          description={t("connectorsSettings.runtimeDescription")}
        >
          {kept.map((toolset) => (
            <McpConnectorRow
              key={toolset.name}
              logo={<McpConnectorLogo id={`toolset:${toolset.name}`} name={toolset.label} />}
              name={toolset.label}
              description={toolset.description || toolset.name}
              onOpen={() => setSelected(toolset)}
              action={<ToneBadge tone={status[toolset.status].tone}>{status[toolset.status].label}</ToneBadge>}
            />
          ))}
        </McpConnectorSection>
      )}
      <ToolsetDialog toolset={selected} onClose={() => setSelected(null)} canManage={data.management.capabilities.toolsets} />
    </>
  );
}
