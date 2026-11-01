import { IconCheck } from "@tabler/icons-react";
import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@openedbot/browser-ui-kit";
import { canOperateWorkspace, type BotDto } from "@openedbot/contracts-api";
import type { McpConnectorEntry } from "@openedbot/runtimes/domain/mcp-connector-catalog";
import { api, queryKeys, runtimesQueryOptions } from "../../../lib/api";
import { hasMcpLiveReload } from "../../../lib/mcp-live-reload";
import { useT } from "../../../lib/i18n";
import { BUTTON, Note } from "../../../components/settings/primitives";
import { McpConnectorLogo } from "../../../components/mcp-connector-row";
import { BotFace } from "../../../components/bot-face";
import { McpOauthDialog } from "./connectors-mcp-oauth";
import { GatewayRestartCard } from "./connectors-mcp-gateway";
import {
  botPickerOptions,
  mcpConnectBlocker,
  mcpDisconnectBlocker,
  type McpConnectBlocker,
  type McpDisconnectBlocker,
} from "./connectors-catalog-model";

type Target = { entry: McpConnectorEntry; bot: BotDto };

/**
 * « Ajouter » depuis Réglages › Connecteurs.
 *
 * Un jeton MCP vit dans le home d'UN profil Hermes : autoriser à la racine ne
 * servirait aucun bot. Le geste demande donc d'abord « à quel bot ? », puis
 * joue exactement le flux du volet MCP d'un bot : la route de connexion du
 * catalogue (`api.connectMcpConnector`), dans la boîte OAuth des réglages.
 * Mêmes portes que cette route : opérateur qui écrit, hôte qui annonce
 * `mcp_oauth_profile`, bot qui a un profil.
 */
export function useConnectorAdd() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const runtimes = useQuery(runtimesQueryOptions());
  const features = runtimes.data?.runtimes[0]?.linkFeatures ?? [];
  const writable = Boolean(me.data?.session.canWrite && canOperateWorkspace(me.data.session.role));
  // Tant que la session n'est pas lue, le rôle n'est pas un refus : le bouton
  // attend, sans afficher de raison qui serait peut-être fausse.
  const blocker: McpConnectBlocker = me.isPending
    ? null
    : mcpConnectBlocker({ writable, featuresPending: runtimes.isPending, features });
  const disconnectBlocker: McpDisconnectBlocker = me.isPending
    ? null
    : mcpDisconnectBlocker({ writable, featuresPending: runtimes.isPending, features });
  const [picking, setPicking] = useState<McpConnectorEntry | null>(null);
  const [alreadyConnected, setAlreadyConnected] = useState<ReadonlySet<string>>(new Set());
  const [connecting, setConnecting] = useState<Target | null>(null);
  const [connected, setConnected] = useState<Target | null>(null);

  const onConnected = useCallback(() => {
    if (connecting) {
      setConnected(connecting);
      void queryClient.invalidateQueries({ queryKey: queryKeys.botCapabilities(connecting.bot.id) });
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeMcp });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeIntegrations });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeGateway });
    // La connexion s'inscrit dans la configuration du profil : « Connectés » la lit là.
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeProfiles });
  }, [connecting, queryClient]);

  const botId = connecting?.bot.id ?? null;
  const start = useCallback((server: string) => api.connectMcpConnector(server, botId!), [botId]);

  return {
    blocker,
    ready: !me.isPending,
    busy: picking !== null || connecting !== null,
    /** `connectedBots` : les bots qui portent déjà l'entrée (le choix les signale, sans les griser). */
    add: (entry: McpConnectorEntry, connectedBots: Iterable<string> = []) => {
      if (blocker === null && !me.isPending && picking === null && connecting === null) {
        setAlreadyConnected(new Set(connectedBots));
        setPicking(entry);
      }
    },
    disconnectBlocker,
    connected,
    gatewayRestart: features.includes("gateway_restart"),
    /** L'hôte recharge MCP tout seul : aucun redémarrage à demander après un geste MCP. */
    liveReload: hasMcpLiveReload(features),
    elements: (
      <>
        <ConnectorBotPicker
          entry={picking}
          connectedBots={alreadyConnected}
          onClose={() => setPicking(null)}
          onPick={(bot) => {
            if (!picking) return;
            setConnected(null);
            setConnecting({ entry: picking, bot });
            setPicking(null);
          }}
        />
        <ConnectorOauth target={connecting} start={start} onClose={() => setConnecting(null)} onConnected={onConnected} />
      </>
    ),
  };
}

function ConnectorOauth({
  target,
  start,
  onClose,
  onConnected,
}: {
  target: Target | null;
  start: (server: string) => ReturnType<typeof api.connectMcpConnector>;
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useT();
  return (
    <McpOauthDialog
      server={target?.entry.id ?? null}
      title={target ? t("connectorsPage.oauthTitle", { name: target.entry.name, bot: target.bot.name }) : undefined}
      pairing={target ? {
        service: { name: target.entry.name, logo: <McpConnectorLogo id={target.entry.id} name={target.entry.name} /> },
        bot: { name: target.bot.name, face: <BotFace name={target.bot.name} seed={target.bot.id} face={target.bot.face} className="size-12" /> },
      } : undefined}
      start={start}
      onClose={onClose}
      onConnected={onConnected}
    />
  );
}

/** « Connecter <Nom> à quel bot ? » : la liste des bots, grisés sans profil. */
export function ConnectorBotPicker({
  entry,
  connectedBots = new Set(),
  onClose,
  onPick,
}: {
  entry: McpConnectorEntry | null;
  /** Ces bots portent déjà l'entrée : les choisir réautorise (jeton expiré, autre compte). */
  connectedBots?: ReadonlySet<string>;
  onClose: () => void;
  onPick: (bot: BotDto) => void;
}) {
  const { t } = useT();
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster, enabled: entry !== null });
  const options = roster.data ? botPickerOptions(roster.data.bots) : [];
  return (
    <Dialog
      open={entry !== null}
      onClose={onClose}
      title={entry ? t("connectorsPage.pickerTitle", { name: entry.name }) : undefined}
      description={t("connectorsPage.pickerDescription")}
      closeLabel={t("common.close")}
      className="max-w-md"
      footer={<button type="button" className={BUTTON.secondary} onClick={onClose}>{t("common.cancel")}</button>}
    >
      {entry && entry.note === "workspaceAdmin" ? (
        <Note tone="neutral" className="mb-3">{t("mcpCatalog.noteWorkspaceAdmin")}</Note>
      ) : null}
      {roster.isPending ? (
        <p className="text-sm text-muted-foreground">{t("connectorsPage.pickerLoading")}</p>
      ) : roster.isError ? (
        <Note tone="danger" role="alert">{t("connectorsPage.pickerLoadError")}</Note>
      ) : options.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("connectorsPage.pickerEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-0.5" data-connector-bot-picker="">
          {options.map(({ bot, disabled }) => (
            <li key={bot.id}>
              <button
                type="button"
                disabled={disabled !== null}
                onClick={() => onPick(bot)}
                className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-transparent"
              >
                <BotFace name={bot.name} seed={bot.id} face={bot.face} animated={false} className="size-9 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{bot.name}</span>
                    {connectedBots.has(bot.id) ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-pos-soft px-1.5 py-px text-[11px] font-medium text-pos-700">
                        <IconCheck aria-hidden className="size-3" />
                        {t("connectorsPage.pickerConnectedBadge")}
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {disabled === "profile"
                      ? t("connectorsPage.pickerNoProfile")
                      : connectedBots.has(bot.id)
                        ? t("connectorsPage.pickerReconnect")
                        : t("connectorsPage.pickerProfile", { profile: bot.hermesProfile ?? "" })}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** Ce que dit la page après une connexion : le fait, et le redémarrage qui la rend effective. */
export function ConnectorAddedNotice({
  add,
  onRestarted,
}: {
  add: ReturnType<typeof useConnectorAdd>;
  onRestarted: () => void;
}) {
  const { t } = useT();
  if (!add.connected) return null;
  return (
    <div className="space-y-2">
      <Note tone="success" role="status">
        {t(add.liveReload ? "connectorsPage.connectedNoticeLive" : "connectorsPage.connectedNotice", {
          name: add.connected.entry.name,
          bot: add.connected.bot.name,
        })}
      </Note>
      {add.gatewayRestart ? <GatewayRestartCard onRestarted={onRestarted} onlyWhenPending={add.liveReload} /> : null}
    </div>
  );
}
