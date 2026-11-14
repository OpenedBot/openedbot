import { useCallback, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BotDto, BotMcpServerDto } from "@openedbot/contracts-api";
import { MCP_CONNECTOR_CATALOG, type McpConnectorEntry } from "@openedbot/runtimes/domain/mcp-connector-catalog";
import { api, runtimesQueryOptions } from "../lib/api";
import { hasMcpLiveReload } from "../lib/runtime/mcp-live-reload";
import { useT } from "../lib/i18n";
import { McpOauthDialog, type McpOauthStart } from "../screens/settings/installation/connectors/connectors-mcp-oauth";
import { invalidateMcpConnectionReads } from "../screens/settings/installation/connectors/connectors-mcp-shared";
import { GatewayRestartCard } from "../screens/settings/installation/connectors/connectors-mcp-gateway";
import {
  CATEGORY_LABEL,
  botCatalogOffer,
  catalogEntryOfProfileServer,
  connectorDescriptionKey,
  mcpConnectBlocker,
  type McpConnectBlocker,
} from "../screens/settings/installation/connectors/connectors-catalog-model";
import { CONNECTOR_PILL, McpConnectorLogo, McpConnectorRow } from "./mcp-connector-row";
import { Note } from "./settings/primitives";
import { RELAY_FEATURE_GATEWAY_RESTART, RELAY_FEATURE_MCP_PROFILE_DISCONNECT } from "@openedbot/contracts-connector/features";

export type { McpConnectBlocker } from "../screens/settings/installation/connectors/connectors-catalog-model";

/**
 * Connecting a catalogue entry to THIS bot, shared by the
 * « Catalogue » section and by the « Reconnecter » button of servers already carried.
 *
 * A single flow: authorization opens in the settings OAuth dialog
 * (`McpOauthDialog`), started by the catalogue connection route, which
 * adds the server to the host if needed and authorizes FOR THE bot's PROFILE. The
 * provider opens through a link the user clicks: no popup
 * window a browser would block.
 */
export function useBotMcpConnect(bot: BotDto, writable: boolean, open: boolean) {
  const queryClient = useQueryClient();
  const runtimes = useQuery({ ...runtimesQueryOptions(), enabled: open });
  const features = runtimes.data?.runtimes[0]?.linkFeatures ?? [];
  const [connecting, setConnecting] = useState<McpConnectorEntry | null>(null);
  const [connected, setConnected] = useState(false);

  const blocker: McpConnectBlocker = mcpConnectBlocker({
    hasProfile: Boolean(bot.hermesProfile),
    writable,
    featuresPending: runtimes.isPending,
    features,
  });

  const onConnected = useCallback(() => {
    setConnected(true);
    invalidateMcpConnectionReads(queryClient, bot.id);
  }, [bot.id, queryClient]);

  const start = useCallback<McpOauthStart>((server, options) => api.connectMcpConnector(server, bot.id, options), [bot.id]);

  const dialog = (
    <McpOauthDialog
      server={connecting?.id ?? null}
      title={connecting?.name}
      start={start}
      onClose={() => setConnecting(null)}
      onConnected={onConnected}
    />
  );

  return {
    blocker,
    /** `true` while a connection's dialog is open: a second click does not open another. */
    busy: connecting !== null,
    connect: (entry: McpConnectorEntry) => {
      if (blocker === null && connecting === null) setConnecting(entry);
    },
    /**
     * The catalogue entry a bot's server IS (name and, from a host that says
     * it, endpoint and OAuth): only those reconnect or disconnect from here.
     */
    catalogEntry: (server: BotMcpServerDto) => catalogEntryOfProfileServer(server),
    connected,
    gatewayRestart: features.includes(RELAY_FEATURE_GATEWAY_RESTART),
    /** The host reloads MCP on its own: no restart to ask for after an MCP gesture. */
    liveReload: hasMcpLiveReload(features),
    /** The host can remove a catalogue server from this profile, token included. */
    canDisconnect: writable && Boolean(bot.hermesProfile) && features.includes(RELAY_FEATURE_MCP_PROFILE_DISCONNECT),
    dialog,
  };
}

/**
 * The « Catalogue » section of a bot's MCP panel: the entries its profile
 * does not carry yet (`botCatalogOffer`, Settings' rule). A connected entry
 * moves into the bot's server list (above), with its toggle; it is never
 * shown twice. An entry whose name another server of the profile takes is
 * greyed out with why.
 */
export function BotMcpCatalogSection({
  profileServers,
  connect,
  onRestarted,
}: {
  profileServers: BotMcpServerDto[] | null;
  connect: ReturnType<typeof useBotMcpConnect>;
  onRestarted: () => void;
}) {
  const { t } = useT();
  const offer = botCatalogOffer(profileServers, MCP_CONNECTOR_CATALOG);
  let reason: ReactNode = null;
  if (connect.blocker === "profile") reason = t("mcpCatalog.unavailableProfile");
  else if (connect.blocker === "role") reason = t("mcpCatalog.unavailableRole");
  else if (connect.blocker === "host") reason = t("mcpCatalog.unavailableHost");

  return (
    <section className="space-y-2" aria-labelledby="bot-mcp-catalog-title">
      <h3 id="bot-mcp-catalog-title" className="text-sm font-medium">{t("mcpCatalog.title")}</h3>
      <p className="text-xs text-muted-foreground">{t("mcpCatalog.intro")}</p>
      {connect.connected ? (
        <div className="space-y-2">
          <Note tone="success" role="status">{t(connect.liveReload ? "mcpCatalog.connectedLive" : "mcpCatalog.connectedRestart")}</Note>
          {connect.gatewayRestart ? <GatewayRestartCard onRestarted={onRestarted} onlyWhenPending={connect.liveReload} /> : null}
        </div>
      ) : null}
      {reason ? <Note tone="warning">{reason}</Note> : null}
      {offer.length > 0 ? (
        <ul className="grid grid-cols-1">
          {offer.map(({ entry, taken }) => {
            const description = connectorDescriptionKey(entry.id);
            return (
              <McpConnectorRow
                key={entry.id}
                logo={<McpConnectorLogo id={entry.id} name={entry.name} />}
                name={entry.name}
                description={description ? t(description) : t(CATEGORY_LABEL[entry.category])}
                caption={taken
                  ? t("mcpCatalog.nameTaken", { name: entry.id })
                  : entry.note === "workspaceAdmin" ? t("mcpCatalog.noteWorkspaceAdmin") : undefined}
                action={
                  <button
                    type="button"
                    className={CONNECTOR_PILL}
                    disabled={taken || connect.blocker !== null || connect.busy}
                    onClick={() => connect.connect(entry)}
                  >
                    {t("mcpCatalog.connect")}
                  </button>
                }
              />
            );
          })}
        </ul>
      ) : null}
      {connect.dialog}
    </section>
  );
}
