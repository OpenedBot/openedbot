import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@openedbot/browser-ui-kit";
import { api, errorMessage } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { BUTTON, Note } from "../../../../components/settings/primitives";
import { BotFace } from "../../../../components/bot-face";
import { GatewayRestartCard } from "./connectors-mcp-gateway";
import type { ConnectorConnection, McpDisconnectBlocker } from "./connectors-catalog-model";
import { invalidateMcpConnectionReads } from "./connectors-mcp-shared";

type Done = { kind: "bot"; bot: string } | { kind: "root" };

/**
 * « Gérer » an entry of « Connectés »: the bots that carry it, each with
 * « Déconnecter », the root's token if any, and « Connecter un bot ». A bot
 * whose token the host knows absent reads « À autoriser », with « Autoriser »
 * for that bot: never « connecté » (`profileServerState`).
 *
 * Disconnecting a bot removes the server from ITS profile and erases ITS token on
 * the host; the other bots are not touched. The root is removed only
 * when no bot still carries the entry: its server serves as the model for the
 * profiles, and a bot's toggle rereads it.
 */
export function ConnectorManageDialog({
  connection,
  open,
  onClose,
  blocker,
  canRemoveRoot,
  gatewayRestart,
  liveReload,
  onConnectBot,
  onAuthorizeBot,
  connectDisabled,
}: {
  /** `null` while the box is open: nothing is connected anymore. */
  connection: ConnectorConnection | null;
  open: boolean;
  onClose: () => void;
  blocker: McpDisconnectBlocker;
  /** The host exposes MCP administration (removal of a server from the root). */
  canRemoveRoot: boolean;
  gatewayRestart: boolean;
  /** The host reloads MCP on its own: disconnection applies without a restart. */
  liveReload: boolean;
  onConnectBot: () => void;
  /** Authorizes the entry for this bot, which carries it without a token. */
  onAuthorizeBot: (botId: string) => void;
  connectDisabled: boolean;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const entry = connection?.entry ?? null;

  const invalidate = (botId?: string) => invalidateMcpConnectionReads(queryClient, botId);
  const disconnectBot = useMutation({
    mutationFn: (input: { connector: string; botId: string; bot: string }) =>
      api.disconnectMcpConnector(input.connector, input.botId),
    onSuccess: (_result, input) => {
      setConfirming(null);
      setDone({ kind: "bot", bot: input.bot });
    },
    onSettled: (_result, _error, input) => invalidate(input.botId),
  });
  const removeRoot = useMutation({
    mutationFn: (name: string) => api.removeRuntimeMcpServer(name),
    onSuccess: () => {
      setConfirming(null);
      setDone({ kind: "root" });
    },
    onSettled: () => invalidate(),
  });
  const failure = disconnectBot.error ?? removeRoot.error;
  const busy = disconnectBot.isPending || removeRoot.isPending;

  const close = () => {
    setConfirming(null);
    setDone(null);
    disconnectBot.reset();
    removeRoot.reset();
    onClose();
  };

  const blockerNote = blocker === "role"
    ? t("mcpCatalog.unavailableRole")
    : blocker === "host"
      ? t("connectorsPage.disconnectUnavailableHost")
      : null;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={entry?.name}
      description={t("connectorsPage.manageDescription")}
      closeLabel={t("common.close")}
      className="max-w-lg"
      footer={
        <>
          <button type="button" className={BUTTON.secondary} onClick={close}>{t("common.close")}</button>
          {entry ? (
            <button
              type="button"
              className={BUTTON.primary}
              disabled={connectDisabled || busy}
              onClick={() => {
                close();
                onConnectBot();
              }}
            >
              {t("connectorsPage.connectBot")}
            </button>
          ) : null}
        </>
      }
    >
      <div className="space-y-4">
        {done ? (
          <div className="space-y-2">
            <Note tone="success" role="status">
              {done.kind === "bot"
                ? t(liveReload ? "connectorsPage.disconnectedLive" : "connectorsPage.disconnected", { name: entry?.name ?? "", bot: done.bot })
                : t("connectorsPage.disconnectedRoot", { name: entry?.name ?? "" })}
            </Note>
            {gatewayRestart ? <GatewayRestartCard onRestarted={() => invalidate()} onlyWhenPending={liveReload} /> : null}
          </div>
        ) : null}
        {failure ? (
          <Note tone="danger" role="alert">{errorMessage(failure, t("connectorsPage.disconnectFailed"))}</Note>
        ) : null}
        {blockerNote ? <Note tone="warning">{blockerNote}</Note> : null}

        {!connection ? (
          <p className="text-sm text-muted-foreground">{t("connectorsPage.manageNothing")}</p>
        ) : (
          <>
            <section aria-labelledby="connector-manage-bots" className="space-y-2">
              <h3 id="connector-manage-bots" className="text-sm font-medium">{t("connectorsPage.manageBots")}</h3>
              {connection.bots.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("connectorsPage.manageNoBot")}</p>
              ) : (
                <ul className="divide-y divide-border/60 rounded-xl border border-border/60" data-connector-bots="">
                  {connection.bots.map((link) => {
                    const key = `bot:${link.botId}`;
                    return (
                      <li key={link.botId} className="flex items-center gap-3 px-3 py-2.5">
                        <BotFace name={link.name} seed={link.botId} face={link.face} animated={false} className="size-8 shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{link.name}</span>
                          {link.state === "authorize" ? (
                            <span className="block truncate text-xs text-warn-700">
                              {t(link.enabled ? "connectorsPage.botToAuthorizeCaption" : "connectorsPage.botDisabledToAuthorizeCaption", { profile: link.profile })}
                            </span>
                          ) : (
                            <span className="block truncate text-xs text-muted-foreground">
                              {link.enabled
                                ? t("connectorsPage.pickerProfile", { profile: link.profile })
                                : t("connectorsPage.botDisabledCaption", { profile: link.profile })}
                            </span>
                          )}
                        </span>
                        {link.state === "authorize" && confirming !== key ? (
                          <button
                            type="button"
                            className={BUTTON.small}
                            aria-label={t("connectorsPage.authorizeAria", { name: connection.entry.name, bot: link.name })}
                            disabled={connectDisabled || busy}
                            onClick={() => {
                              close();
                              onAuthorizeBot(link.botId);
                            }}
                          >
                            {t("connectorsPage.authorize")}
                          </button>
                        ) : null}
                        <ConfirmButton
                          confirming={confirming === key}
                          pending={disconnectBot.isPending && disconnectBot.variables?.botId === link.botId}
                          disabled={blocker !== null || busy}
                          label={t("connectorsPage.disconnect")}
                          ariaLabel={t("connectorsPage.disconnectAria", { name: connection.entry.name, bot: link.name })}
                          onAsk={() => {
                            setDone(null);
                            setConfirming(key);
                          }}
                          onCancel={() => setConfirming(null)}
                          onConfirm={() => disconnectBot.mutate({ connector: connection.entry.id, botId: link.botId, bot: link.name })}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {connection.rootToken ? (
              <section aria-labelledby="connector-manage-root" className="space-y-2">
                <h3 id="connector-manage-root" className="text-sm font-medium">{t("connectorsPage.rootTitle")}</h3>
                <div className="flex items-center gap-3 rounded-xl border border-border/60 px-3 py-2.5">
                  <span className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
                    {connection.bots.length > 0 ? t("connectorsPage.rootRemoveBlocked") : t("connectorsPage.rootCaption")}
                  </span>
                  {connection.bots.length === 0 ? (
                    <ConfirmButton
                      confirming={confirming === "root"}
                      pending={removeRoot.isPending}
                      disabled={!canRemoveRoot || blocker !== null || busy}
                      label={t("connectorsPage.rootRemove")}
                      ariaLabel={t("connectorsPage.rootRemoveAria", { name: connection.entry.name })}
                      onAsk={() => {
                        setDone(null);
                        setConfirming("root");
                      }}
                      onCancel={() => setConfirming(null)}
                      onConfirm={() => removeRoot.mutate(connection.entry.id)}
                    />
                  ) : null}
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

/** A gesture that erases a token: a first click asks, the second does it. */
function ConfirmButton({
  confirming,
  pending,
  disabled,
  label,
  ariaLabel,
  onAsk,
  onCancel,
  onConfirm,
}: {
  confirming: boolean;
  pending: boolean;
  disabled: boolean;
  label: string;
  ariaLabel: string;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useT();
  if (pending) return <span className="shrink-0 text-xs text-muted-foreground">{t("connectorsPage.disconnecting")}</span>;
  if (!confirming) {
    return (
      <button type="button" className={BUTTON.small} aria-label={ariaLabel} disabled={disabled} onClick={onAsk}>
        {label}
      </button>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <button type="button" className={BUTTON.small} onClick={onCancel}>{t("common.cancel")}</button>
      <button type="button" className={BUTTON.danger} disabled={disabled} onClick={onConfirm}>
        {t("connectorsPage.disconnectConfirm")}
      </button>
    </span>
  );
}
