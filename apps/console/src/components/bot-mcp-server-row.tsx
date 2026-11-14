import { useState } from "react";
import type { BotMcpServerDto } from "@openedbot/contracts-api";
import { Switch, cn } from "@openedbot/browser-ui-kit";
import { useT } from "../lib/i18n";
import { BUTTON } from "./settings/primitives";
import { profileServerState } from "../screens/settings/installation/connectors/connectors-catalog-model";

/**
 * One MCP server of a bot's profile, in its MCP panel. What it is worth comes
 * from `profileServerState`, the rule « Connectés » reads too: a server whose
 * token the host knows absent says « À autoriser », and its catalogue gesture
 * is « Autoriser », not « Reconnecter »; a host that does not say (older
 * edge-setup) renders it as before. A server outside the catalogue has no
 * authorization openedbot can play for a bot: its note says so and points
 * at the gesture that works here, the switch.
 */
export function BotMcpServerRow({
  server,
  catalog,
  writable,
  pending,
  onChange,
  onReconnect,
  onDisconnect,
  disconnecting = false,
}: {
  server: BotMcpServerDto;
  /** The server IS a catalogue entry (`catalogEntryOfProfileServer`). */
  catalog: boolean;
  writable: boolean;
  pending: boolean;
  onChange: (enabled: boolean) => void;
  /** Present for a catalogue server this bot can (re)authorize. */
  onReconnect?: () => void;
  /** Present for a catalogue server the host can remove from this profile. */
  onDisconnect?: () => void;
  disconnecting?: boolean;
}) {
  const { t } = useT();
  const [confirming, setConfirming] = useState(false);
  const toAuthorize = profileServerState(server) === "authorize";
  return (
    <li className={cn("rounded-md border px-3 py-2", !server.enabled && "opacity-60")}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm">{server.name}</p>
          {toAuthorize ? (
            <p className="mt-1 text-xs text-warn-700">{t(catalog ? "botCapabilities.mcpToAuthorize" : "botCapabilities.mcpToAuthorizeManual")}</p>
          ) : null}
          {server.unreachable ? <p className="mt-1 text-xs text-destructive-text">{t("botCapabilities.mcpUnreachable")}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pending ? <span className="text-xs text-muted-foreground">{t("botCapabilities.updating")}</span> : null}
          {disconnecting ? (
            <span className="text-xs text-muted-foreground">{t("connectorsPage.disconnecting")}</span>
          ) : confirming && onDisconnect ? (
            <>
              <button type="button" className={BUTTON.small} onClick={() => setConfirming(false)}>{t("common.cancel")}</button>
              <button
                type="button"
                className={BUTTON.danger}
                onClick={() => {
                  setConfirming(false);
                  onDisconnect();
                }}
              >
                {t("connectorsPage.disconnectConfirm")}
              </button>
            </>
          ) : (
            <>
              {onReconnect ? (
                <button type="button" className={BUTTON.soft} onClick={onReconnect}>
                  {t(toAuthorize ? "mcpCatalog.authorize" : "mcpCatalog.reconnect")}
                </button>
              ) : null}
              {onDisconnect ? (
                <button
                  type="button"
                  className={BUTTON.small}
                  aria-label={t("botCapabilities.mcpDisconnectAria", { name: server.name })}
                  onClick={() => setConfirming(true)}
                >
                  {t("connectorsPage.disconnect")}
                </button>
              ) : null}
            </>
          )}
          <Switch
            checked={server.enabled}
            aria-label={server.name}
            disabled={!writable || pending}
            onCheckedChange={onChange}
          />
        </div>
      </div>
    </li>
  );
}
