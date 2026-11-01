import { useCallback, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BotDto, BotMcpServerDto } from "@openedbot/contracts-api";
import {
  MCP_PROFILE_DISCONNECT_FEATURE,
  mcpCatalogOffer,
  mcpConnectorEntry,
  type McpConnectorEntry,
} from "@openedbot/runtimes/domain/mcp-connector-catalog";
import { api, queryKeys, runtimesQueryOptions } from "../lib/api";
import { hasMcpLiveReload } from "../lib/runtime/mcp-live-reload";
import { useT } from "../lib/i18n";
import { McpOauthDialog } from "../screens/settings/installation/connectors/connectors-mcp-oauth";
import { GatewayRestartCard } from "../screens/settings/installation/connectors/connectors-mcp-gateway";
import {
  CATEGORY_LABEL,
  connectorDescriptionKey,
  mcpConnectBlocker,
  type McpConnectBlocker,
} from "../screens/settings/installation/connectors/connectors-catalog-model";
import { CONNECTOR_PILL, McpConnectorLogo, McpConnectorRow } from "./mcp-connector-row";
import { Note } from "./settings/primitives";

export type { McpConnectBlocker } from "../screens/settings/installation/connectors/connectors-catalog-model";

/**
 * La connexion d'une entrée du catalogue à CE bot, partagée par la section
 * « Catalogue » et par le bouton « Reconnecter » des serveurs déjà portés.
 *
 * Un seul flux : l'autorisation s'ouvre dans la boîte OAuth des réglages
 * (`McpOauthDialog`), démarrée par la route de connexion du catalogue, qui
 * ajoute le serveur à l'hôte au besoin et autorise POUR LE PROFIL du bot. Le
 * fournisseur s'ouvre par un lien que l'utilisateur clique : pas de fenêtre
 * surgissante qu'un navigateur bloquerait.
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
    void queryClient.invalidateQueries({ queryKey: queryKeys.botCapabilities(bot.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeMcp });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeGateway });
  }, [bot.id, queryClient]);

  const start = useCallback((server: string) => api.connectMcpConnector(server, bot.id), [bot.id]);

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
    /** `true` tant que la boîte d'une connexion est ouverte : un second clic n'en ouvre pas une autre. */
    busy: connecting !== null,
    connect: (entry: McpConnectorEntry) => {
      if (blocker === null && connecting === null) setConnecting(entry);
    },
    /** Le serveur d'un bot vient-il du catalogue ? Seuls ceux-là se reconnectent d'ici. */
    catalogEntry: (name: string) => mcpConnectorEntry(name),
    connected,
    gatewayRestart: features.includes("gateway_restart"),
    /** L'hôte recharge MCP tout seul : aucun redémarrage à demander après un geste MCP. */
    liveReload: hasMcpLiveReload(features),
    /** L'hôte sait retirer un serveur du catalogue de ce profil, jeton compris. */
    canDisconnect: writable && Boolean(bot.hermesProfile) && features.includes(MCP_PROFILE_DISCONNECT_FEATURE),
    dialog,
  };
}

/**
 * La section « Catalogue » du volet MCP d'un bot : les entrées que son profil
 * ne porte pas encore. Une entrée connectée passe dans la liste des serveurs
 * du bot (au-dessus), avec sa bascule ; elle n'est jamais montrée deux fois.
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
  const offer = mcpCatalogOffer(profileServers);
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
          {offer.map((entry) => {
            const description = connectorDescriptionKey(entry.id);
            return (
              <McpConnectorRow
                key={entry.id}
                logo={<McpConnectorLogo id={entry.id} name={entry.name} />}
                name={entry.name}
                description={description ? t(description) : t(CATEGORY_LABEL[entry.category])}
                caption={entry.note === "workspaceAdmin" ? t("mcpCatalog.noteWorkspaceAdmin") : undefined}
                action={
                  <button
                    type="button"
                    className={CONNECTOR_PILL}
                    disabled={connect.blocker !== null || connect.busy}
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
