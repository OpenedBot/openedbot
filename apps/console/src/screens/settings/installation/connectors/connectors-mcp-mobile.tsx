import { useEffect, useRef, useState } from "react";
import { IconCheck, IconChevronRight, IconPlus, IconSearch } from "@tabler/icons-react";
import { cn, Dialog, Input } from "@openedbot/browser-ui-kit";
import type {
  RuntimeIntegrationMcpCatalogEntryDto,
  RuntimeIntegrationMcpServerDto,
} from "@openedbot/contracts-api";
import { useT } from "../../../../lib/i18n";
import { BUTTON } from "../../../../components/settings/primitives";
import {
  InsetGroupedSection,
  InsetGroupedStatic,
  insetGroupedRowClassName,
} from "../../../../components/mobile/inset-grouped";
import { serverState } from "./connectors-mcp-shared";

/* ─── Phone: the rows and the sheets ─────────────────────────── */

const TILE_TONE: Record<"success" | "warning" | "neutral", string> = {
  success: "bg-pos-700",
  warning: "bg-warn-700",
  neutral: "bg-[var(--openedbot-grouped-chevron)]",
};

/**
 * A server's row, on the phone: the fact, never the action.
 *
 * `Retirer` has left the row. A destructive button set permanently beside
 * the name, in a list where the finger scrolls, is an error waiting for its
 * moment; the gesture now lives in the detail, behind an alert that
 * names the server. The row now carries only a state and a chevron.
 */
export function McpServerListRow({
  server,
  onOpen,
}: {
  server: RuntimeIntegrationMcpServerDto;
  onOpen: () => void;
}) {
  const { t, formatNumber } = useT();
  const state = serverState(server);
  const location = server.endpoint ?? server.command ?? null;
  // The subtitle says where the server comes from and what it is worth today.
  // « Porté par la plateforme » adds nothing on a row: it is the nominal
  // case, and the tool count proves it better than a sentence.
  const detail = state.key === "mcpOnPlatform" || state.key === "mcpOauthAuthorized"
    ? server.discoveredTools && server.discoveredTools.length > 0
      ? t("connectorsSettings.mcpDiscoveredTools", {
          count: formatNumber(server.discoveredTools.length),
        })
      : t(`connectorsSettings.${state.key}`)
    : t(`connectorsSettings.${state.key}`);
  const host = location === null
    ? null
    : location.startsWith("http")
      ? location.replace(/^https?:\/\//u, "").replace(/\/.*$/u, "")
      : location;

  return (
    <li>
      <button
        type="button"
        data-inset-grouped-row=""
        aria-label={t("connectorsSettings.mcpOpenServer", { name: server.name })}
        onClick={onOpen}
        className={insetGroupedRowClassName}
      >
        <span
          aria-hidden
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-[7px] text-[13px] leading-none font-semibold text-white",
            TILE_TONE[state.tone],
          )}
        >
          {server.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 py-3">
          <span className="block truncate text-[17px] leading-[22px] text-[var(--openedbot-grouped-label)]">
            {server.name}
          </span>
          <span
            className={cn(
              "mt-0.5 block truncate text-[13px] leading-4",
              state.tone === "warning" ? "text-warn-700" : "text-[var(--openedbot-grouped-caption)]",
            )}
          >
            {host ? `${host} · ${detail}` : detail}
          </span>
        </span>
        <IconChevronRight aria-hidden className="size-5 shrink-0 text-[var(--openedbot-grouped-chevron)]" />
      </button>
    </li>
  );
}

/** A blue action row: « Ajouter un serveur », last of the group. */
export function McpActionRow({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: typeof IconPlus;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-inset-grouped-row=""
        disabled={disabled}
        aria-disabled={disabled || undefined}
        onClick={onClick}
        className={cn(
          insetGroupedRowClassName,
          "text-[var(--openedbot-grouped-back)] disabled:opacity-45",
        )}
      >
        <Icon aria-hidden className="size-[22px] shrink-0 stroke-[1.5]" />
        <span className="min-w-0 flex-1 py-3 text-left text-[17px] leading-[22px]">{label}</span>
      </button>
    </li>
  );
}

/**
 * A server's detail: what the row does not say, and the two gestures.
 *
 * The sheet survives its close for a moment: the server is read from
 * `mcp.servers`, and a removal makes it disappear from the list before the
 * sheet has finished sliding. `lastRef` therefore keeps the last server shown
 * so the body does not empty under the eyes during the animation.
 */
export function McpServerSheet({
  server,
  busy,
  oauthEnabled,
  removing,
  onAuthorize,
  onRemove,
  onClose,
}: {
  server: RuntimeIntegrationMcpServerDto | null;
  busy: boolean;
  oauthEnabled: boolean;
  removing: boolean;
  onAuthorize: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { t, formatNumber } = useT();
  const [confirming, setConfirming] = useState(false);
  const lastRef = useRef<RuntimeIntegrationMcpServerDto | null>(null);
  if (server !== null) lastRef.current = server;
  const shown = server ?? lastRef.current;
  useEffect(() => {
    if (server === null) setConfirming(false);
  }, [server]);

  if (shown === null) return null;
  const state = serverState(shown);
  const tools = shown.discoveredTools ?? [];

  return (
    <>
      <Dialog
        open={server !== null}
        onClose={onClose}
        title={shown.name}
        closeLabel={t("common.close")}
        bodyClassName="px-0 py-0"
        footer={
          <>
            {state.authorizable && oauthEnabled ? (
              <button type="button" className={BUTTON.primary} onClick={onAuthorize} disabled={busy}>
                {t("connectorsSettings.mcpOauthAuthorize")}
              </button>
            ) : null}
            <button type="button" className={BUTTON.danger} disabled={busy} onClick={() => setConfirming(true)}>
              {removing ? t("connectorsSettings.mcpRemoving") : t("connectorsSettings.mcpRemove")}
            </button>
          </>
        }
      >
        <div className="pb-4">
          <InsetGroupedSection className="pt-2">
            <InsetGroupedStatic
              label={t("connectorsSettings.mcpColumnTransport")}
              value={
                shown.transport === "stdio"
                  ? t("connectorsSettings.mcpTransportStdio")
                  : t("connectorsSettings.mcpTransportHttp")
              }
            />
            {shown.endpoint ?? shown.command ? (
              <InsetGroupedStatic
                label={t("connectorsSettings.mcpColumnEndpoint")}
                value={shown.endpoint ?? shown.command ?? ""}
                multiline
              />
            ) : null}
            <InsetGroupedStatic
              label={t("connectorsSettings.mcpColumnState")}
              value={t(`connectorsSettings.${state.key}`)}
              multiline
            />
          </InsetGroupedSection>

          {tools.length === 0 ? (
            /* An empty card topped with « aucun outil » said the same
               nothing twice: only the sentence remains, under its title. */
            <section data-inset-grouped="" className="px-4 pt-4">
              <h2 className="px-4 pb-1 text-[13px] leading-4 font-normal text-[var(--openedbot-grouped-caption)]">
                {t("connectorsSettings.mcpToolsTitle")}
              </h2>
              <p className="px-4 text-[15px] leading-5 text-[var(--openedbot-grouped-caption)]">
                {t("connectorsSettings.mcpToolsNone")}
              </p>
            </section>
          ) : (
            <InsetGroupedSection
              caption={t("connectorsSettings.mcpToolsTitle")}
              footer={t("connectorsSettings.mcpDiscoveredTools", {
                count: formatNumber(tools.length),
              })}
            >
              {tools.map((tool) => <InsetGroupedStatic key={tool} label={tool} />)}
            </InsetGroupedSection>
          )}

          {shown.envKeys.length > 0 ? (
            <InsetGroupedSection caption={t("connectorsSettings.mcpEnvTitle")}>
              {shown.envKeys.map((key) => <InsetGroupedStatic key={key} label={key} />)}
            </InsetGroupedSection>
          ) : null}
        </div>
      </Dialog>

      {/* The removal's confirmation: an app alert, not the browser's grey
          box: the same sheet, the same blue, the same red. */}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        role="alertdialog"
        title={t("connectorsSettings.mcpRemoveTitle", { name: shown.name })}
        /* The title already names the server: the desktop `confirm()`'s sentence
           repeated it word for word two lines below. Here it says only the
           consequence. */
        description={t("connectorsSettings.mcpRemoveConsequence")}
        closeLabel={t("common.close")}
        showClose={false}
        showHandle={false}
        // A destructive decision is not dismissed with a swipe: « Annuler » is an
        // answer, a missed gesture is not one.
        swipeToDismiss={false}
        footer={
          <>
            <button type="button" className={BUTTON.danger} disabled={busy} onClick={() => { setConfirming(false); onRemove(); }}>
              {t("connectorsSettings.mcpRemove")}
            </button>
            <button type="button" className={BUTTON.secondary} onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </button>
          </>
        }
      />
    </>
  );
}

/**
 * The approved catalog, in a searchable sheet.
 *
 * Each row opens the wiring box, including an entry with no
 * variable. On desktop a direct click is legitimate: the button is named
 * « Installer », it is far from the thumb, and nothing else moves. With a finger,
 * in a list that scrolls, an unlucky press would write on the host without
 * anything having announced it: the box says what is about to be played, and carries the only
 * button that plays it.
 */
export function McpCatalogSheet({
  open,
  entries,
  total,
  installed,
  busy,
  query,
  onQuery,
  onClose,
  onOpen,
}: {
  open: boolean;
  entries: readonly RuntimeIntegrationMcpCatalogEntryDto[];
  total: number;
  installed: Set<string>;
  busy: boolean;
  query: string;
  onQuery: (value: string) => void;
  onClose: () => void;
  onOpen: (entry: RuntimeIntegrationMcpCatalogEntryDto) => void;
}) {
  const { t, formatNumber } = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("connectorsSettings.mcpCatalogTitle")}
      // During a search, the total alone lied to the eye: « 20 entrées »
      // above a single row. The subtitle then says what remains.
      description={
        entries.length === total
          ? t("connectorsSettings.mcpCatalogCount", { count: formatNumber(total) })
          : t("connectorsSettings.mcpCatalogFiltered", {
              count: formatNumber(entries.length),
              total: formatNumber(total),
            })
      }
      closeLabel={t("common.close")}
      bodyClassName="px-0 py-0"
      // A sheet that takes the screen: twenty-four entries behind a
      // search field deserve the height, not a third of the glass.
      className="h-[calc(100dvh-var(--openedbot-safe-top)-2.5rem)]"
    >
      <div className="sticky top-0 z-10 bg-[var(--openedbot-grouped-canvas)] px-4 pb-2">
        <div className="relative">
          <IconSearch
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-[var(--openedbot-grouped-caption)]"
          />
          <Input
            type="search"
            className="pl-9"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder={t("connectorsSettings.mcpCatalogSearch")}
            aria-label={t("connectorsSettings.mcpCatalogSearchLabel")}
            autoComplete="off"
            spellCheck={false}
            data-dialog-autofocus=""
          />
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="px-8 pt-6 text-[15px] leading-5 text-[var(--openedbot-grouped-caption)]">
          {t("connectorsSettings.mcpCatalogNoMatch", { query: query.trim() })}
        </p>
      ) : (
        <InsetGroupedSection className="pt-0 pb-6">
          {entries.map((entry) => (
            <McpCatalogListRow
              key={entry.name}
              entry={entry}
              installed={installed.has(entry.name)}
              busy={busy}
              onOpen={() => onOpen(entry)}
            />
          ))}
        </InsetGroupedSection>
      )}
    </Dialog>
  );
}

/** A catalog entry, as a grouped row: the name, its sentence, the gesture. */
function McpCatalogListRow({
  entry,
  installed,
  busy,
  onOpen,
}: {
  entry: RuntimeIntegrationMcpCatalogEntryDto;
  installed: boolean;
  busy: boolean;
  onOpen: () => void;
}) {
  const { t } = useT();
  return (
    <li>
      <button
        type="button"
        data-inset-grouped-row=""
        disabled={installed || busy}
        aria-disabled={installed || busy || undefined}
        onClick={onOpen}
        className={cn(insetGroupedRowClassName, "items-start")}
      >
        <span className="min-w-0 flex-1 py-3">
          <span
            className={cn(
              "block truncate text-[17px] leading-[22px]",
              installed ? "text-[var(--openedbot-grouped-caption)]" : "text-[var(--openedbot-grouped-label)]",
            )}
          >
            {entry.name}
          </span>
          {/* No `block` here: `line-clamp-2` sets `display: -webkit-box`,
              and the two classes fought over the same property; `figma`'s
              sentence took three lines and broke the list's rhythm. */}
          <span className="mt-0.5 line-clamp-2 text-left text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
            {entry.description || t("connectorsSettings.noDescription")}
          </span>
        </span>
        {installed ? (
          <span className="flex shrink-0 items-center gap-1 self-center text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
            <IconCheck aria-hidden className="size-4 text-pos-700" stroke={2.25} />
            {t("connectorsSettings.mcpInstalled")}
          </span>
        ) : (
          <IconChevronRight
            aria-hidden
            className="size-5 shrink-0 self-center text-[var(--openedbot-grouped-chevron)]"
          />
        )}
      </button>
    </li>
  );
}
