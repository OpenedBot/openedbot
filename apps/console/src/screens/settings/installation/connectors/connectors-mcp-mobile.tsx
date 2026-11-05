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

/* ─── Téléphone : les lignes et les feuilles ─────────────────────────── */

const TILE_TONE: Record<"success" | "warning" | "neutral", string> = {
  success: "bg-pos-700",
  warning: "bg-warn-700",
  neutral: "bg-[var(--openedbot-grouped-chevron)]",
};

/**
 * La ligne d'un serveur, sur téléphone : le fait, jamais l'action.
 *
 * `Retirer` a quitté la ligne. Un bouton destructeur posé en permanence à côté
 * du nom, dans une liste où le doigt défile, est une erreur qui attend son
 * heure ; le geste vit maintenant dans le détail, derrière une alerte qui
 * nomme le serveur. La ligne ne porte plus qu'un état et un chevron.
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
  // Le sous-titre dit d'où vient le serveur et ce qu'il vaut aujourd'hui.
  // « Porté par la plateforme » n'apporte rien sur une ligne : c'est le cas
  // nominal, et le nombre d'outils le prouve mieux qu'une phrase.
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

/** Une ligne-action bleue : « Ajouter un serveur », dernière du groupe. */
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
 * Le détail d'un serveur : ce que la ligne ne dit pas, et les deux gestes.
 *
 * La feuille survit un instant à sa fermeture : le serveur est lu depuis
 * `mcp.servers`, et un retrait le fait disparaître de la liste avant que la
 * feuille ait fini de glisser. `lastRef` garde donc le dernier serveur montré
 * pour que le corps ne se vide pas sous les yeux pendant l'animation.
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
            /* Une carte vide surmontée de « aucun outil » disait deux fois le
               même rien : il ne reste que la phrase, sous son titre. */
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

      {/* La confirmation du retrait : une alerte de l'app, pas la boîte grise
          du navigateur : la même feuille, le même bleu, le même rouge. */}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        role="alertdialog"
        title={t("connectorsSettings.mcpRemoveTitle", { name: shown.name })}
        /* Le titre nomme déjà le serveur : la phrase du `confirm()` bureau le
           répétait mot pour mot deux lignes plus bas. Ici elle ne dit que la
           conséquence. */
        description={t("connectorsSettings.mcpRemoveConsequence")}
        closeLabel={t("common.close")}
        showClose={false}
        showHandle={false}
        // Une décision destructive ne se balaye pas : « Annuler » est une
        // réponse, un geste raté n'en est pas une.
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
 * Le catalogue approuvé, en feuille cherchable.
 *
 * Chaque ligne ouvre la boîte de branchement, y compris une entrée sans
 * variable. Sur desktop un clic direct est légitime : le bouton est nommé
 * « Installer », il est loin du pouce, et rien d'autre ne bouge. Au doigt,
 * dans une liste qui défile, un appui malheureux écrirait sur l'hôte sans que
 * rien ne l'ait annoncé : la boîte dit ce qui va être joué, et porte le seul
 * bouton qui le joue.
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
      // Pendant une recherche, le total seul mentait à l'œil : « 20 entrées »
      // au-dessus d'une seule ligne. Le sous-titre dit alors ce qui reste.
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
      // Une feuille qui occupe l'écran : vingt-quatre entrées derrière un
      // champ de recherche méritent la hauteur, pas un tiers de vitre.
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

/** Une entrée du catalogue, en ligne groupée : le nom, sa phrase, le geste. */
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
          {/* Pas de `block` ici : `line-clamp-2` pose `display: -webkit-box`,
              et les deux classes se disputaient la même propriété ; la phrase
              de `figma` tenait trois lignes et cassait le rythme de la liste. */}
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
