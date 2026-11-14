import { IconCheck } from "@tabler/icons-react";
import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@openedbot/browser-ui-kit";
import { canOperateWorkspace, type BotDto } from "@openedbot/contracts-api";
import type { McpConnectorEntry } from "@openedbot/runtimes/domain/mcp-connector-catalog";
import { api, queryKeys, runtimesQueryOptions } from "../../../../lib/api";
import { hasMcpLiveReload } from "../../../../lib/runtime/mcp-live-reload";
import { useT } from "../../../../lib/i18n";
import { BUTTON, Note } from "../../../../components/settings/primitives";
import { McpConnectorLogo } from "../../../../components/mcp-connector-row";
import { BotFace } from "../../../../components/bot-face";
import { McpOauthDialog, type McpOauthStart } from "./connectors-mcp-oauth";
import { invalidateMcpConnectionReads } from "./connectors-mcp-shared";
import { GatewayRestartCard } from "./connectors-mcp-gateway";
import {
  botPickerOptions,
  catalogNameTaken,
  mcpConnectBlocker,
  mcpDisconnectBlocker,
  type McpConnectBlocker,
  type McpDisconnectBlocker,
} from "./connectors-catalog-model";
import { RELAY_FEATURE_GATEWAY_RESTART } from "@openedbot/contracts-connector/features";

type Target = { entry: McpConnectorEntry; bot: BotDto };

/**
 * « Ajouter » from Settings › Connectors.
 *
 * An MCP token lives in the home of ONE Hermes profile: authorizing at the root would
 * serve no bot. The gesture therefore asks first « à quel bot ? », then
 * plays exactly the flow of a bot's MCP panel: the catalog's connection
 * route (`api.connectMcpConnector`), in the settings OAuth box.
 * The same gates as that route: an operator who writes, a host that announces
 * `mcp_oauth_profile`, a bot that has a profile.
 */
export function useConnectorAdd() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const runtimes = useQuery(runtimesQueryOptions());
  const features = runtimes.data?.runtimes[0]?.linkFeatures ?? [];
  const writable = Boolean(me.data?.session.canWrite && canOperateWorkspace(me.data.session.role));
  // While the session is not read, the role is not a refusal: the button
  // waits, without showing a reason that might be false.
  const blocker: McpConnectBlocker = me.isPending
    ? null
    : mcpConnectBlocker({ writable, featuresPending: runtimes.isPending, features });
  const disconnectBlocker: McpDisconnectBlocker = me.isPending
    ? null
    : mcpDisconnectBlocker({ writable, featuresPending: runtimes.isPending, features });
  const [picking, setPicking] = useState<McpConnectorEntry | null>(null);
  const [alreadyConnected, setAlreadyConnected] = useState<ReadonlySet<string>>(new Set());
  const [toAuthorize, setToAuthorize] = useState<ReadonlySet<string>>(new Set());
  const [connecting, setConnecting] = useState<Target | null>(null);
  const [connected, setConnected] = useState<Target | null>(null);

  const onConnected = useCallback(() => {
    if (connecting) setConnected(connecting);
    invalidateMcpConnectionReads(queryClient, connecting?.bot.id);
  }, [connecting, queryClient]);

  const botId = connecting?.bot.id ?? null;
  const start = useCallback<McpOauthStart>((server, options) => api.connectMcpConnector(server, botId!, options), [botId]);

  return {
    blocker,
    ready: !me.isPending,
    busy: picking !== null || connecting !== null,
    /**
     * `connectedBots`: the bots already connected to the entry; `authorizeBots`:
     * those that carry it without a token. The choice marks both, without
     * greying them out: choosing one (re)authorizes it.
     */
    add: (entry: McpConnectorEntry, connectedBots: Iterable<string> = [], authorizeBots: Iterable<string> = []) => {
      if (blocker === null && !me.isPending && picking === null && connecting === null) {
        setAlreadyConnected(new Set(connectedBots));
        setToAuthorize(new Set(authorizeBots));
        setPicking(entry);
      }
    },
    /** Authorizes the entry for a bot already chosen (it carries it without a token): no picker. */
    authorize: (entry: McpConnectorEntry, bot: BotDto) => {
      if (blocker === null && !me.isPending && picking === null && connecting === null && bot.hermesProfile) {
        setConnected(null);
        setConnecting({ entry, bot });
      }
    },
    disconnectBlocker,
    connected,
    gatewayRestart: features.includes(RELAY_FEATURE_GATEWAY_RESTART),
    /** The host reloads MCP on its own: no restart to ask for after an MCP gesture. */
    liveReload: hasMcpLiveReload(features),
    elements: (
      <>
        <ConnectorBotPicker
          entry={picking}
          connectedBots={alreadyConnected}
          authorizeBots={toAuthorize}
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
  start: McpOauthStart;
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

/** « Connecter <Nom> à quel bot ? »: the list of bots, greyed out with no profile. */
export function ConnectorBotPicker({
  entry,
  connectedBots = new Set(),
  authorizeBots = new Set(),
  onClose,
  onPick,
}: {
  entry: McpConnectorEntry | null;
  /** These bots already carry the entry: choosing them reauthorizes (expired token, another account). */
  connectedBots?: ReadonlySet<string>;
  /** These carry it without a token: choosing them authorizes. */
  authorizeBots?: ReadonlySet<string>;
  onClose: () => void;
  onPick: (bot: BotDto) => void;
}) {
  const { t } = useT();
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster, enabled: entry !== null });
  // Which profile already carries another server under the entry's name:
  // read when the host says it; unread or older host, nothing is greyed.
  const profiles = useQuery({ queryKey: queryKeys.runtimeProfiles, queryFn: api.runtimeProfiles, enabled: entry !== null });
  const taken = (bot: BotDto) => entry !== null && catalogNameTaken(
    profiles.data?.profiles.find((profile) => profile.name === bot.hermesProfile)?.mcpServers,
    entry,
  );
  const options = roster.data ? botPickerOptions(roster.data.bots, taken) : [];
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
                      : disabled === "taken"
                        ? t("mcpCatalog.nameTaken", { name: entry?.id ?? "" })
                        : connectedBots.has(bot.id)
                          ? t("connectorsPage.pickerReconnect")
                          : authorizeBots.has(bot.id)
                            ? t("connectorsPage.pickerAuthorize")
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

/** What the page says after a connection: the fact, and the restart that makes it effective. */
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
