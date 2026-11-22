import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconPlug } from "@tabler/icons-react";
import { canOperateWorkspace } from "@openedbot/contracts-api";
import { Popover, Tooltip, TooltipContent, TooltipTrigger, cn } from "@openedbot/browser-ui-kit";
import { MCP_CONNECTOR_CATALOG } from "@openedbot/runtimes/domain/mcp-connector-catalog";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useSecondaryReadsReady } from "../../lib/shell/after-first-paint";
import {
  botLinksToAuthorize,
  catalogConnections,
  connectedBotLinks,
  isListedConnection,
  type ConnectorConnection,
} from "../../screens/settings/installation/connectors/connectors-catalog-model";
import { McpConnectorLogo } from "../mcp-connector-row";
import { POPOVER_ROW, RAIL_PILL, RAIL_PILL_BUTTON } from "./rail-llm-quotas";

export const CONNECTORS_SETTINGS_PATH = "/settings/connectors";

/**
 * Up to three logos; past three, two and a « +N » chip in the third slot, so
 * the pill never grows past three logos' width.
 */
const MAX_LOGOS = 3;

/** 6 px around 24 px logos. */
const CONNECTORS_PILL = cn(RAIL_PILL, "px-1.5");

/** Small logos that overlap, each ringed with the card's surface to stand apart. */
const STACKED_LOGO = "size-6 rounded-md ring-2 ring-background-secondary-default [&>svg]:size-3.5";

/**
 * The connected connectors, read as Settings › Connectors reads them
 * (`ConnectorsTab`): the API's snapshots, never `?fresh=1`, which starts an
 * interpreter on the host. `null` while unread, for a member (these reads
 * are the operators'), or after a failed read: the pill then says nothing
 * rather than « aucun ».
 */
function useConnectedConnectors(): ConnectorConnection[] | null {
  const secondary = useSecondaryReadsReady();
  const auth = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const enabled = secondary && auth.data !== undefined && canOperateWorkspace(auth.data.session.role);
  const inventory = useQuery({ queryKey: queryKeys.runtimeIntegrations, queryFn: () => api.runtimeIntegrations(), enabled });
  const canMcp = inventory.data?.management.capabilities.mcp === true;
  const mcp = useQuery({ queryKey: queryKeys.runtimeMcp, queryFn: api.runtimeMcp, enabled: enabled && canMcp });
  const profiles = useQuery({ queryKey: queryKeys.runtimeProfiles, queryFn: api.runtimeProfiles, enabled });
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster, enabled });
  // A role lost or a refetch that fails keeps TanStack's previous data: neither shows it.
  const reads = canMcp ? [inventory, profiles, roster, mcp] : [inventory, profiles, roster];
  if (!enabled || reads.some((read) => read.isPending || read.isError)) return null;
  return catalogConnections({
    catalog: MCP_CONNECTOR_CATALOG,
    // No profile inventory on this host (`null`): the root's tokens still count, as on the page.
    profiles: profiles.data?.profiles ?? null,
    bots: roster.data?.bots ?? null,
    rootServers: mcp.data?.available ? mcp.data.servers : null,
  }).filter(isListedConnection);
}

/** The plug, alone in the pill: before any reading, for a member, or with nothing connected. */
function PlugMark() {
  return (
    <span aria-hidden className="inline-flex size-6 items-center justify-center text-foreground-icon-secondary">
      <IconPlug className="size-[18px]" />
    </span>
  );
}

/** The pill before any reading, also drawn by the frame skeleton (`RailFooterSkeleton`). */
export function RailConnectorsPillLoading() {
  return (
    <span aria-hidden data-rail-connectors-pill="loading" className={CONNECTORS_PILL}>
      <PlugMark />
    </span>
  );
}

/**
 * « Connecteurs » on the foot row of the conversations card, after « Modèles »
 * (operator request of 17-11-2026): the logos of the connected connectors,
 * overlapping. A click opens a popover listing them, each row and « Gérer les
 * connecteurs » leading to Settings › Connectors. With none connected, for a
 * member, or while the reading is on its way: a plug, and the click goes
 * straight to the page. Right-aligned with Settings, so its width changing
 * moves nothing but free room.
 */
export function RailConnectorsPill({ onOpenSettings }: { onOpenSettings: (to: string) => void }) {
  const { t } = useT();
  const connected = useConnectedConnectors();
  const focusFirstRow = useCallback((node: HTMLDivElement | null) => node?.querySelector("button")?.focus(), []);
  const label = t("connectorsPage.tabConnectors");

  if (connected === null || connected.length === 0) {
    const empty = connected !== null;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-rail-connectors-pill={empty ? "empty" : ""}
            aria-label={empty ? `${label} ${t("connectorsPage.railAdd")}` : label}
            className={cn(CONNECTORS_PILL, RAIL_PILL_BUTTON)}
            onClick={() => onOpenSettings(CONNECTORS_SETTINGS_PATH)}
          >
            <PlugMark />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    );
  }

  const shown = connected.length > MAX_LOGOS ? connected.slice(0, MAX_LOGOS - 1) : connected;
  const hidden = connected.length - shown.length;
  return (
    <Popover
      side="top"
      align="start"
      width={300}
      className="p-1.5"
      trigger={({ ref, onClick, "aria-expanded": expanded }) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={ref}
              type="button"
              data-rail-connectors-pill=""
              aria-haspopup="dialog"
              aria-expanded={expanded}
              aria-label={[label, ...connected.map((connection) => connection.entry.name)].join(" ")}
              className={cn(CONNECTORS_PILL, RAIL_PILL_BUTTON)}
              onClick={onClick}
            >
              <span aria-hidden className="flex items-center -space-x-1.5">
                {shown.map((connection) => (
                  <McpConnectorLogo key={connection.entry.id} id={connection.entry.id} name={connection.entry.name} className={STACKED_LOGO} />
                ))}
                {hidden > 0 ? (
                  <span className={cn(STACKED_LOGO, "flex items-center justify-center bg-background-tertiary-default text-[11px] font-medium text-text-secondary tabular-nums")}>
                    +{hidden}
                  </span>
                ) : null}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{label}</TooltipContent>
        </Tooltip>
      )}
    >
      {(close) => {
        const open = () => {
          close();
          onOpenSettings(CONNECTORS_SETTINGS_PATH);
        };
        return (
          <div ref={focusFirstRow} className="flex flex-col">
            {connected.map((connection) => {
              const bots = connectedBotLinks(connection);
              const toAuthorize = botLinksToAuthorize(connection);
              return (
                <button key={connection.entry.id} type="button" data-rail-connector={connection.entry.id} className={POPOVER_ROW} onClick={open}>
                  <McpConnectorLogo id={connection.entry.id} name={connection.entry.name} className="size-7 rounded-md [&>svg]:size-4" />
                  <span className="min-w-0">
                    <span className="block truncate">{connection.entry.name}</span>
                    <span className="block truncate text-caption-1-regular text-text-tertiary">
                      {bots.length > 0
                        ? t("connectorsPage.connectedTo", { bots: bots.map((link) => link.name).join(", ") })
                        : t("connectorsPage.rootOnlyCaption")}
                    </span>
                    {toAuthorize.length > 0 ? (
                      <span className="block truncate text-caption-1-regular text-warn-700">
                        {t("connectorsPage.toAuthorizeCaption", { bots: toAuthorize.map((link) => link.name).join(", ") })}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            <div aria-hidden className="mx-2 my-1 h-px bg-border" />
            <button type="button" className={POPOVER_ROW} onClick={open}>
              <span className="min-w-0">{t("connectorsPage.railManage")}</span>
            </button>
          </div>
        );
      }}
    </Popover>
  );
}
