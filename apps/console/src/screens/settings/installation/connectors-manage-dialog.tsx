import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@openedbot/browser-ui-kit";
import { api, errorMessage, queryKeys } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { BUTTON, Note } from "../../../components/settings/primitives";
import { BotFace } from "../../../components/bot-face";
import { GatewayRestartCard } from "./connectors-mcp-gateway";
import type { ConnectorConnection, McpDisconnectBlocker } from "./connectors-catalog-model";

type Done = { kind: "bot"; bot: string } | { kind: "root" };

/**
 * « Gérer » une entrée de « Connectés » : les bots qui la portent, chacun avec
 * « Déconnecter », le jeton éventuel de la racine, et « Connecter un bot ».
 *
 * Déconnecter un bot retire le serveur de SON profil et efface SON jeton sur
 * l'hôte ; les autres bots ne sont pas touchés. La racine ne se retire que
 * quand plus aucun bot ne porte l'entrée : son serveur sert de modèle aux
 * profils, et la bascule d'un bot le relit.
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
  connectDisabled,
}: {
  /** `null` alors que la boîte est ouverte : plus rien n'est connecté. */
  connection: ConnectorConnection | null;
  open: boolean;
  onClose: () => void;
  blocker: McpDisconnectBlocker;
  /** L'hôte expose l'administration MCP (retrait d'un serveur de la racine). */
  canRemoveRoot: boolean;
  gatewayRestart: boolean;
  /** L'hôte recharge MCP tout seul : la déconnexion s'applique sans redémarrage. */
  liveReload: boolean;
  onConnectBot: () => void;
  connectDisabled: boolean;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const entry = connection?.entry ?? null;

  const invalidate = (botId?: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeProfiles });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeMcp });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeIntegrations });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeGateway });
    if (botId) void queryClient.invalidateQueries({ queryKey: queryKeys.botCapabilities(botId) });
  };
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
                          <span className="block truncate text-xs text-muted-foreground">
                            {link.enabled
                              ? t("connectorsPage.pickerProfile", { profile: link.profile })
                              : t("connectorsPage.botDisabledCaption", { profile: link.profile })}
                          </span>
                        </span>
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

/** Un geste qui efface un jeton : un premier clic demande, le second fait. */
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
