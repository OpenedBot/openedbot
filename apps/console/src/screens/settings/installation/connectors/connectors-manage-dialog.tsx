import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RiLoader4Line } from "@remixicon/react";
import type { RuntimeProfileInventoryDto } from "@openedbot/contracts-api";
import { Dialog } from "@openedbot/browser-ui-kit";
import { api, errorMessage, queryKeys } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { BUTTON, Note } from "../../../../components/settings/primitives";
import { BotFace } from "../../../../components/bot-face";
import { GatewayRestartCard } from "./connectors-mcp-gateway";
import { catalogEntryOfProfileServer, type ConnectorConnection, type McpDisconnectBlocker } from "./connectors-catalog-model";
import { invalidateMcpConnectionReads } from "./connectors-mcp-shared";

/** What the box says it did, for the connector it did it on. */
type Done = { kind: "bot"; connector: string; bot: string } | { kind: "root"; connector: string };

/** A bot's disconnection on a connector: the key of its spinner and of its error. */
const linkKey = (connector: string, botId: string) => `${connector}:${botId}`;

/**
 * The host confirmed: the bot's profile no longer carries the entry. The
 * cached profiles say so at once, so the row leaves now instead of after a
 * reread that may be slow, cancelled by another one, or failing. The reread
 * that follows confirms it.
 */
function withoutConnection(inventory: RuntimeProfileInventoryDto | null | undefined, connector: string, botId: string) {
  if (!inventory) return inventory;
  return {
    ...inventory,
    profiles: inventory.profiles.map((profile) => profile.importedBotId !== botId ? profile : {
      ...profile,
      mcpServers: (profile.mcpServers ?? []).filter((server) => catalogEntryOfProfileServer(server)?.id !== connector),
    }),
  };
}

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
 *
 * Each disconnection runs on its own row: the others, « Autoriser » and
 * « Connecter un bot » stay usable meanwhile. The row shows a spinner from
 * « Confirmer » and leaves as soon as the host confirms (`withoutConnection`);
 * a failure brings it back with its error under its own name.
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
  // The disconnections in flight, and the failed ones, per `linkKey`: several run at once.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, unknown>>(() => new Map());
  // Confirming unmounts the focused button: focus goes to the list's heading.
  const botsHeading = useRef<HTMLHeadingElement>(null);
  const entry = connection?.entry ?? null;

  const invalidate = (botId?: string) => invalidateMcpConnectionReads(queryClient, botId);
  // Hook-level callbacks: they run for EVERY call, where `mutate(_, { onSuccess })` only follows the last one.
  const disconnectBot = useMutation({
    mutationFn: (input: { connector: string; botId: string; bot: string }) =>
      api.disconnectMcpConnector(input.connector, input.botId),
    onMutate: (input) => {
      const key = linkKey(input.connector, input.botId);
      setLeaving((current) => new Set(current).add(key));
      setFailures((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    },
    onSuccess: (_result, input) => {
      queryClient.setQueryData<RuntimeProfileInventoryDto | null>(
        queryKeys.runtimeProfiles,
        (inventory) => withoutConnection(inventory, input.connector, input.botId),
      );
      setDone({ kind: "bot", connector: input.connector, bot: input.bot });
    },
    onError: (error, input) => setFailures((current) => new Map(current).set(linkKey(input.connector, input.botId), error)),
    onSettled: (_result, _error, input) => {
      setLeaving((current) => {
        const next = new Set(current);
        next.delete(linkKey(input.connector, input.botId));
        return next;
      });
      invalidate(input.botId);
    },
  });
  const removeRoot = useMutation({
    mutationFn: (name: string) => api.removeRuntimeMcpServer(name),
    onSuccess: (_result, connector) => {
      setConfirming(null);
      setDone({ kind: "root", connector });
    },
    onSettled: () => invalidate(),
  });
  // A result belongs to the connector it was obtained on, not to the one open now.
  const shownDone = done && done.connector === entry?.id ? done : null;

  // A disconnection already sent keeps running: closing only clears what the box says.
  const close = () => {
    setConfirming(null);
    setDone(null);
    setFailures(new Map());
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
              disabled={connectDisabled || removeRoot.isPending}
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
        {shownDone ? (
          <div className="space-y-2">
            <Note tone="success" role="status">
              {shownDone.kind === "bot"
                ? t(liveReload ? "connectorsPage.disconnectedLive" : "connectorsPage.disconnected", { name: entry?.name ?? "", bot: shownDone.bot })
                : t("connectorsPage.disconnectedRoot", { name: entry?.name ?? "" })}
            </Note>
            {gatewayRestart ? <GatewayRestartCard onRestarted={() => invalidate()} onlyWhenPending={liveReload} /> : null}
          </div>
        ) : null}
        {removeRoot.error ? (
          <Note tone="danger" role="alert">{errorMessage(removeRoot.error, t("connectorsPage.disconnectFailed"))}</Note>
        ) : null}
        {blockerNote ? <Note tone="warning">{blockerNote}</Note> : null}

        {!connection ? (
          <p className="text-sm text-muted-foreground">{t("connectorsPage.manageNothing")}</p>
        ) : (
          <>
            <section aria-labelledby="connector-manage-bots" className="space-y-2">
              <h3 ref={botsHeading} id="connector-manage-bots" tabIndex={-1} className="text-sm font-medium outline-none">{t("connectorsPage.manageBots")}</h3>
              {connection.bots.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("connectorsPage.manageNoBot")}</p>
              ) : (
                <ul className="divide-y divide-border/60 rounded-xl border border-border/60" data-connector-bots="">
                  {connection.bots.map((link) => {
                    const key = `bot:${link.botId}`;
                    const linkLeaving = leaving.has(linkKey(connection.entry.id, link.botId));
                    const linkFailure = failures.get(linkKey(connection.entry.id, link.botId));
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
                          {linkFailure ? (
                            <span role="alert" className="block text-xs text-destructive">
                              {errorMessage(linkFailure, t("connectorsPage.disconnectFailed"))}
                            </span>
                          ) : null}
                        </span>
                        {link.state === "authorize" && confirming !== key && !linkLeaving ? (
                          <button
                            type="button"
                            className={BUTTON.secondary}
                            aria-label={t("connectorsPage.authorizeAria", { name: connection.entry.name, bot: link.name })}
                            disabled={connectDisabled}
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
                          pending={linkLeaving}
                          disabled={blocker !== null}
                          label={t("connectorsPage.disconnect")}
                          ariaLabel={t("connectorsPage.disconnectAria", { name: connection.entry.name, bot: link.name })}
                          onAsk={() => {
                            setDone(null);
                            setConfirming(key);
                          }}
                          onCancel={() => setConfirming(null)}
                          onConfirm={() => {
                            setConfirming(null);
                            botsHeading.current?.focus();
                            disconnectBot.mutate({ connector: connection.entry.id, botId: link.botId, bot: link.name });
                          }}
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
                      disabled={!canRemoveRoot || blocker !== null || removeRoot.isPending}
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
  if (pending) {
    return (
      <span role="status" className="inline-flex h-8 shrink-0 items-center gap-1.5 px-2 text-xs text-muted-foreground">
        <RiLoader4Line aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
        {t("connectorsPage.disconnecting")}
      </span>
    );
  }
  if (!confirming) {
    return (
      <button type="button" className={BUTTON.secondary} aria-label={ariaLabel} disabled={disabled} onClick={onAsk}>
        {label}
      </button>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <button type="button" className={BUTTON.secondary} onClick={onCancel}>{t("common.cancel")}</button>
      <button type="button" className={BUTTON.danger} disabled={disabled} onClick={onConfirm}>
        {t("connectorsPage.disconnectConfirm")}
      </button>
    </span>
  );
}
