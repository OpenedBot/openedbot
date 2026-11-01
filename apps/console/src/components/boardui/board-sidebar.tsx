import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RiAddFill,
  RiArrowRightSLine,
  RiCheckLine,
  RiExpandUpDownLine,
  RiHome5Line,
  RiInboxLine,
  RiSearchLine,
} from "@remixicon/react";
import type { BotDto, GroupDto, OperatorProfileDto, RosterDto, SectionDto } from "@openedbot/contracts-api";
import { formatListTime } from "@openedbot/browser-i18n";
import { stripHandlePrefix } from "@openedbot/roster/domain/ask-user";
import { filterRosterBots, filterRosterGroups, normalizeRosterQuery } from "@openedbot/roster/domain/roster-search";
import { projectRosterSections, type RosterSectionProjection } from "@openedbot/roster/domain/roster-sections";
import { cn, toast } from "@openedbot/browser-ui-kit";
import { partitionThreadVisibility } from "@/lib/thread-visibility";
import { ApiError, api, queryKeys } from "../../lib/api";
import { registerSpeechRates } from "../../lib/speech-rates";
import { useT } from "../../lib/i18n";
import { BotContextMenu } from "../bot-context-menu";
import { BotFace } from "../bot-face";
import { GroupContextMenu } from "../group-context-menu";
import { GroupDialog } from "../group-dialog";
import { GroupFaceStack } from "../group-face-stack";
import { useBotDialogs } from "../../lib/bot-dialogs";
import { useMobileDrawer } from "../mobile/mobile-drawer-shell";
import { ConnectorUpgradeSidebarLink } from "../dashboard/connector-upgrade-badge";
import { useOperatorIdentity } from "../../lib/operator-identity";
import { useWorkspaceSwitch } from "../workspace/workspace-navigation";
import { AccountMenu } from "./account-menu";
import { BUI_PANEL_ITEM, BuiCloseGlyph, BuiPopover, BuiPopoverContent, BuiPopoverTrigger } from "./menu";
import { COLLAPSE_MOTION, CreateMenu, useBoardChrome } from "./board-chrome";
import { useOpenedOnce } from "../../lib/use-opened-once";
import { useRosterSections } from "../dashboard/use-roster-sections";
import { PINNED_DROP_ID, RosterDragProvider, rosterRowAttributes, useRosterDrag, type RosterDragRow, type RosterDropSlot } from "../dashboard/roster-drag";
import { RosterInsertionLine } from "../dashboard/roster-section";
import { RosterSkeleton } from "../skeletons/frame-skeletons";
import { useSecondaryReadsReady } from "../../lib/after-first-paint";
import { rememberBootSidebarShape } from "../../lib/boot-shape";
import { readBootIdentityLabel, rememberBootIdentity } from "../../lib/boot-identity";
import { readCloudSession } from "../../lib/cloud-session";
import { useAccountLayout } from "../../lib/account-layout";
import { BOARD_SIDEBAR_CARD } from "./board-sidebar-card";

type RosterRow = { kind: "bot"; bot: BotDto } | { kind: "group"; group: GroupDto };

const activityOf = (row: RosterRow) => (row.kind === "bot" ? row.bot.lastActivityAt : row.group.lastActivityAt);

const NO_GROUPS: GroupDto[] = [];
const NO_SECTIONS: SectionDto[] = [];

/**
 * What the bar reads from the roster. Not `cursor`, which every SSE flush
 * advances. `sections` stays: a dossier créé (Fly, …) doit repeindre la
 * barre même si aucune ligne n'a bougé. Le partage structurel de react-query
 * garde la référence d'une ligne non touchée, donc son `memo` tient (OHB-141).
 */
function selectSidebarRoster(roster: RosterDto) {
  return {
    bots: roster.bots,
    groups: roster.groups ?? NO_GROUPS,
    sections: roster.sections ?? NO_SECTIONS,
    operator: roster.operator ?? null,
  };
}

/** Les boutons ronds de la rangée du haut : recherche. */
const TOP_BUTTON =
  "button-press-motion inline-flex h-9 w-full min-w-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-0 bg-background-tertiary-default p-2 text-foreground-icon-secondary shadow-none outline-none select-none hover:bg-background-tertiary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 active:bg-background-tertiary-hover";

/**
 * Les liens de navigation du bureau (Salon, À traiter), sous la rangée du
 * haut : 32 px, icône de 16 px en gris, le gris du survol de la carte, et
 * pour la page ouverte (`aria-current`, posé par `Link`) le dégradé bleu du
 * lien actif du template « Chat Starter », texte et icône en blanc. Le
 * dégradé est posé en propriété arbitraire : `bg-button-primary` est une
 * classe CSS (boardui.css), pas une couleur du thème, et ne prend pas de
 * variante.
 */
export const NAV_ROW =
  "flex h-8 shrink-0 items-center gap-2.5 rounded-2lg px-2.5 text-[13px] leading-[18px] font-medium text-text-primary outline-none ohb-row hover:bg-board-row-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring aria-[current=page]:[background-image:var(--bui-gradient-primary)] aria-[current=page]:text-text-white [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-foreground-icon-secondary aria-[current=page]:[&>svg]:text-text-white aria-[current=page]:[&>span]:text-text-white";

/** Les liens du pied de barre : boutons fantômes à icône, alignés à gauche. */
export const FOOTER_BUTTON =
  "button-press-motion inline-flex h-9 cursor-pointer items-center justify-start gap-0.5 overflow-hidden whitespace-nowrap rounded-2lg bg-transparent p-2 text-body-medium text-text-secondary outline-none select-none hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 active:bg-background-secondary-hover";

/**
 * La barre des conversations du template BoardUI « Multi-agent Chat ».
 *
 * Au bureau (`dense`) : l'organisation et le repli dans la rangée de 46 px
 * sur le fond du cadre, puis la carte grise du template « Chat Starter »
 * avec la rangée du haut (recherche qui s'étend sur toute la largeur,
 * « + »), les liens Salon et À traiter, puis la liste des fils en lignes de
 * 44 px (visage de 28 px, nom, dernier message, heure de la dernière
 * activité) et la ligne du compte. Dans le tiroir mobile, la carte de 260 px
 * d'origine : lignes de 54 px (visage de 40 px) et carte de compte.
 * Réglages et Support vivent dans le menu du compte.
 *
 * Les épinglés ne restent pas une ligne de plus en tête de liste. Comme
 * chez Grok Bot, ils quittent la liste et s'affichent en tuiles (visage
 * en grand, nom dessous, pastille au coin bas droit) centrées sous la
 * rangée du haut. Le reste se range dans les sections du roster (Fly,
 * puis « Sans section » en dernier). Tant qu'il n'y a que la section par
 * défaut, la liste reste plate.
 *
 * À la souris, une ligne se prend et se dépose : dans une section (réordre
 * ou changement de dossier) ou sur le rail d'épingles. Le doigt passe par
 * « Déplacer vers… ».
 */
export function BoardSidebar({ className }: { className?: string }) {
  const { t } = useT();
  const navigate = useNavigate();
  const { botId: routeBotId, groupId } = useParams({ strict: false }) as { botId?: string; groupId?: string };
  const mobileDrawer = useMobileDrawer();
  // Bureau : la barre de la maquette. Le tiroir mobile garde la sienne.
  const dense = !mobileDrawer;
  const requestedAccountLayout = useAccountLayout();
  const accountLayout = dense ? requestedAccountLayout : "base";
  // Variante C : un champ de recherche permanent en tête de liste ; Accueil et À traiter
  // passent dans le rail d'icônes (board-rails.tsx).
  const railShell = accountLayout === "c";
  // Le compteur d'« À traiter », le même relevé que le menu opérateur
  // (`account-menu.tsx`) : invalidé par le flux SSE, rappel lent en filet.
  const secondaryReady = useSecondaryReadsReady();
  const inboxCount = useQuery({
    queryKey: queryKeys.inbox,
    queryFn: api.inbox,
    refetchInterval: 120_000,
    refetchOnReconnect: true,
    enabled: dense && secondaryReady,
    select: (inbox) => inbox.counts.total,
  }).data ?? 0;
  // Le setter seul : lire tout le store re-rendait la barre à chaque `setTab`.
  const roster = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    refetchInterval: 120_000,
    refetchOnReconnect: true,
    select: selectSidebarRoster,
  });
  const sectionActions = useRosterSections();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const openCreateBot = useBotDialogs((state) => state.openCreate);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  // Closed dialogs still run their hooks (`GroupDialog` observes the roster):
  // they mount on first open only.
  const creatingGroupMounted = useOpenedOnce(creatingGroup);

  const allBots = roster.data?.bots ?? [];
  const bots = useMemo(
    () => partitionThreadVisibility(allBots).visible.filter((bot) => bot.archivedAt == null),
    [allBots],
  );
  const allGroups = roster.data?.groups ?? NO_GROUPS;
  const groups = useMemo(() => partitionThreadVisibility(allGroups).visible, [allGroups]);
  const hasQuery = normalizeRosterQuery(query).length > 0;
  const { pinnedRows, listRows } = useMemo(() => {
    const botMatches = filterRosterBots(bots, query);
    const groupMatches = filterRosterGroups(groups, query);
    const pinnedRows: RosterRow[] = [];
    const listRows: RosterRow[] = [];
    for (const row of [
      ...botMatches.map((bot): RosterRow => ({ kind: "bot", bot })),
      ...groupMatches.map((group): RosterRow => ({ kind: "group", group })),
    ]) {
      const pinned = row.kind === "bot" ? row.bot.pinned : row.group.pinned === true;
      (pinned ? pinnedRows : listRows).push(row);
    }
    const byActivity = (a: RosterRow, b: RosterRow) => activityOf(b).localeCompare(activityOf(a));
    pinnedRows.sort(byActivity);
    listRows.sort(byActivity);
    return { pinnedRows, listRows };
  }, [bots, groups, query]);
  const sections = roster.data?.sections ?? NO_SECTIONS;
  // Les épinglés restent dans le rail : ils ne réapparaissent pas sous Fly.
  // Une recherche aplatit : des en-têtes vides n'aident pas à trouver une ligne.
  const projection = useMemo(
    () => projectRosterSections({
      sections,
      rows: listRows,
      sectionIdOf: (row) => (row.kind === "bot" ? row.bot.sectionId : row.group.sectionId),
      positionOf: (row) => (row.kind === "bot" ? row.bot.position : row.group.position),
    }),
    [sections, listRows],
  );
  const showSections = !hasQuery && !projection.flat;

  // The next refresh draws its loading states with this roster's shape
  // (`lib/boot-shape.ts`): pinned tiles, section labels and row counts.
  useEffect(() => {
    if (!dense || hasQuery || !roster.isSuccess) return;
    rememberBootSidebarShape({
      pins: pinnedRows.length,
      blocks: showSections
        ? projection.sections.map((section) => ({ label: true, rows: section.collapsed ? 0 : section.rows.length }))
        : [{ label: listRows.length > 0, rows: listRows.length }],
    });
  }, [dense, hasQuery, roster.isSuccess, pinnedRows.length, showSections, projection, listRows.length]);

  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchInput.current?.focus());
  }, [searchOpen]);
  // Barre repliée, la barre du haut garde la recherche et le « + » : elle les
  // demande ici, où vivent le champ et les dialogues de création.
  const request = useBoardChrome((state) => state.request);
  // Bureau seulement : le tiroir mobile ne se replie pas.
  const collapsed = useBoardChrome((state) => state.collapsed) && dense;
  useEffect(() => {
    if (!request) return;
    if (request.kind === "search") setSearchOpen(true);
    if (request.kind === "createBot") openCreateBot();
    if (request.kind === "createGroup") setCreatingGroup(true);
  }, [request]);
  // La barre est montée sur tous les écrans (bureau et tiroir) : c'est elle
  // qui tient à jour la vitesse de lecture par bot pour tous les fils.
  useEffect(() => {
    registerSpeechRates(allBots.map((candidate) => [candidate.id, candidate.speechRate] as const));
  }, [allBots]);

  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
  };
  // Stable callbacks: the rows are `memo` and render only for their own data.
  const setDrawerOpen = mobileDrawer?.setOpen;
  const closeDrawer = useCallback(() => setDrawerOpen?.(false), [setDrawerOpen]);
  const stopRenaming = useCallback(() => setRenamingId(null), []);
  const operator = roster.data?.operator ?? null;

  const onRosterDrop = useCallback((row: RosterDragRow, target: string, slot: RosterDropSlot | null) => {
    void sectionActions.dropRow(row, target, slot, (sectionId) => {
      if (showSections) return projection.sections.find((section) => section.id === sectionId)?.rows ?? [];
      return listRows;
    });
  }, [listRows, projection.sections, sectionActions, showSections]);

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") closeSearch();
    const first = pinnedRows[0] ?? listRows[0];
    if (event.key === "Enter" && first) {
      if (first.kind === "bot") void navigate({ to: "/bot/$botId", params: { botId: first.bot.id } });
      else void navigate({ to: "/g/$groupId", params: { groupId: first.group.id } });
      closeSearch();
      closeDrawer();
    }
  };


  return (
    <RosterDragProvider enabled={!hasQuery} onDrop={onRosterDrop}>
    <aside
      aria-label={t("appSidebar.navigationLabel")}
      className={cn(
        // Bureau : la carte grise du template « Chat Starter »
        // (`BOARD_SIDEBAR_CARD`), sous la barre du haut du cadre qui porte
        // l'organisation et le repli (`BoardTopBar`). Le tiroir mobile est
        // cette carte entière.
        mobileDrawer
          ? "isolate flex h-full min-h-0 w-[260px] shrink-0 flex-col rounded-3xl border border-border-button-white bg-background-secondary-default p-[7px] text-text-primary shadow-bui-sidebar"
          : cn(
            // Le repli de boardui.com : pendant que la colonne se ferme
            // (board-frame.tsx), le contenu s'efface avec un léger flou, au
            // même pas. Ouverte, aucun filtre : le texte reste net.
            "isolate flex h-full min-h-0 w-[272px] shrink-0 flex-col text-text-primary transition-[opacity,filter]",
            railShell ? "pb-3" : "ps-3 pb-3",
            COLLAPSE_MOTION,
            collapsed ? "opacity-0 [filter:blur(3px)]" : "opacity-100",
          ),
        className,
      )}
    >
      <div className={dense ? BOARD_SIDEBAR_CARD : "contents"}>
      {railShell ? (
        <div className="flex shrink-0 items-center gap-2">
          {/* Au focus, le traitement du composer (DESIGN.md) : le champ s'éclaircit,
              un bord fin et une ombre légère, pas d'anneau de formulaire. */}
          <label className="flex h-8 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-lg border border-transparent bg-background-tertiary-default ps-2.5 pe-2 text-foreground-icon-tertiary transition-[border-color,box-shadow,background-color] duration-200 focus-within:border-composer-edge-hover focus-within:bg-background-primary-default focus-within:shadow-xs">
            <RiSearchLine aria-hidden className="size-4 shrink-0" />
            <input
              ref={searchInput}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKey}
              aria-label={t("appSidebar.searchAriaLabel")}
              placeholder={t("boardui.searchPlaceholder")}
              className="m-0 min-w-0 flex-1 border-0 bg-transparent p-0 text-left font-sans text-body-2-medium text-text-primary outline-none placeholder:text-text-tertiary"
            />
            {hasQuery ? (
              <button
                type="button"
                aria-label={t("boardui.closeSearch")}
                onClick={closeSearch}
                className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground-icon-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
              >
                <BuiCloseGlyph />
              </button>
            ) : null}
          </label>
          {/* Variante C : le « + » ouvre directement la création d'un bot,
              sans le menu bot / chat de groupe. */}
          <button
            type="button"
            aria-label={t("boardui.createBot")}
            title={t("boardui.createBot")}
            onClick={() => openCreateBot()}
            className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-button-primary text-text-white outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            <RiAddFill className="size-[18px]" />
          </button>
        </div>
      ) : (
      <div className="flex shrink-0">
      {dense && accountLayout === "b" ? <AccountMenu variant="avatar-name" side="bottom" align="start" /> : null}
      <div className="relative h-9 min-w-0 flex-1">
        <div className="grid h-full grid-cols-3 gap-2">
          <div aria-hidden />
          <div aria-hidden />
          <div
            aria-hidden={searchOpen}
            className={cn("flex transition-[opacity,transform] duration-200 motion-reduce:transition-none", searchOpen ? "pointer-events-none opacity-0" : "opacity-100")}
          >
            <CreateMenu
              align="start"
              alignOffset={-76}
              trigger={(
                <button
                  type="button"
                  aria-label={t("boardui.create")}
                  title={t("boardui.create")}
                  tabIndex={searchOpen ? -1 : 0}
                  className="flex w-full min-w-0 cursor-pointer items-center justify-center rounded-full bg-button-primary text-text-white outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                >
                  <RiAddFill className="size-5" />
                </button>
              )}
            />
          </div>
        </div>
        <div
          className="absolute inset-y-0 start-0 z-10 overflow-hidden rounded-full bg-background-tertiary-default transition-[width] duration-300 ease-in-out motion-reduce:transition-none"
          style={{ width: searchOpen ? "100%" : "calc((100% - 16px) / 3)" }}
        >
          <button
            type="button"
            aria-label={t("appSidebar.searchAriaLabel")}
            aria-expanded={searchOpen}
            aria-hidden={searchOpen}
            tabIndex={searchOpen ? -1 : 0}
            className={cn(TOP_BUTTON, "absolute inset-0 transition-opacity duration-150", searchOpen && "pointer-events-none opacity-0")}
            onClick={() => setSearchOpen(true)}
          >
            <RiSearchLine className="size-5 shrink-0" />
          </button>
          <div
            inert={!searchOpen}
            aria-hidden={!searchOpen}
            className={cn("relative transition-opacity duration-150", searchOpen ? "opacity-100" : "pointer-events-none opacity-0")}
          >
            <div className="flex h-9 w-full items-center rounded-full bg-background-tertiary-default p-2 ps-3 pe-9 text-foreground-icon-tertiary">
              <div className="flex min-w-0 flex-1 items-center gap-0.5">
                <RiSearchLine className="size-5 shrink-0" />
                <input
                  ref={searchInput}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={onSearchKey}
                  aria-label={t("appSidebar.searchAriaLabel")}
                  placeholder={t("boardui.searchPlaceholder")}
                  className="m-0 min-w-0 flex-1 border-0 bg-transparent p-0 pl-1 text-left font-sans text-body-regular text-text-primary outline-none placeholder:text-text-tertiary focus:placeholder:text-text-primary"
                />
              </div>
            </div>
            <button
              type="button"
              aria-label={t("boardui.closeSearch")}
              onClick={closeSearch}
              className="absolute end-2 top-2 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-secondary outline-none transition-colors duration-150 hover:bg-background-tertiary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <BuiCloseGlyph />
            </button>
          </div>
        </div>
      </div>
      </div>
      )}

      {dense && !railShell ? (
        <nav aria-label={t("appSidebar.primaryNav")} className="mt-3 flex shrink-0 flex-col gap-px">
          <Link to="/" activeOptions={{ exact: true }} className={NAV_ROW}>
            <RiHome5Line aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t("overviewPlaceholder.nav")}</span>
          </Link>
          <Link to="/inbox" className={NAV_ROW}>
            <RiInboxLine aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t("inbox.title")}</span>
            {inboxCount > 0 ? (
              <span aria-label={t("inbox.badge", { count: inboxCount })} className="shrink-0 text-[12px] text-text-tertiary tabular-nums">
                {inboxCount}
              </span>
            ) : null}
          </Link>
        </nav>
      ) : null}

      <div className={cn("relative min-h-0 flex-1", dense ? "mt-1" : "mt-3")}>
        <nav
          aria-label={t("boardui.chatList")}
          className={cn("bui-scroll flex h-full flex-col overflow-y-auto overscroll-contain outline-none", dense ? "gap-1" : "gap-2")}
        >
          {roster.isPending ? <RosterSkeleton label={t("common.loading")} dense={dense} /> : null}
          {roster.isError ? (
            <div role="alert" className="flex flex-col gap-2 rounded-xl bg-background-tertiary-default p-3 text-body-2-medium text-text-secondary">
              {t(roster.data ? "appSidebar.rosterRefreshFailed" : "appSidebar.rosterLoadFailed")}
              <button type="button" className="self-start text-text-primary" onClick={() => void roster.refetch()}>
                {t("appSidebar.retryRoster")}
              </button>
            </div>
          ) : null}
          {pinnedRows.length > 0 ? (
            <PinRail>
              {pinnedRows.map((row) => (
                <PinnedTile
                  key={row.kind === "bot" ? row.bot.id : row.group.id}
                  row={row}
                  active={row.kind === "bot" ? row.bot.id === routeBotId : row.group.id === groupId}
                  renaming={row.kind === "bot" && renamingId === row.bot.id}
                  onRename={setRenamingId}
                  onRenameDone={stopRenaming}
                  onNavigate={closeDrawer}
                />
              ))}
            </PinRail>
          ) : (
            <BoardPinDropZone />
          )}
          {showSections
            ? projection.sections.map((section) => (
              <BoardSectionBlock
                key={section.id}
                section={section}
                label={section.locked ? t("appSidebar.unassigned") : section.name}
                onToggle={() => { void sectionActions.setCollapsed(section.id, !section.collapsed); }}
                routeBotId={routeBotId}
                groupId={groupId}
                operator={operator}
                renamingId={renamingId}
                onRename={setRenamingId}
                onRenameDone={stopRenaming}
                onNavigate={closeDrawer}
                dense={dense}
              />
            ))
            : (
              <div
                data-drop-section={projection.defaultSectionId ?? undefined}
                className={cn("flex flex-col", dense ? "gap-0.5" : "gap-2")}
              >
                {/* Bureau : la liste plate garde son intitulé, comme « Fils »
                    dans la maquette, sous les liens de navigation. */}
                {dense && !hasQuery && listRows.length > 0 ? (
                  <p className={SECTION_LABEL_DENSE}>{t("appSidebar.conversationsGroup")}</p>
                ) : null}
                {listRows.map((row) => renderChatRow(row, {
                  routeBotId,
                  groupId,
                  operator,
                  renamingId,
                  onRename: setRenamingId,
                  onRenameDone: stopRenaming,
                  onNavigate: closeDrawer,
                  dense,
                }))}
                {listRows.length === 0 && projection.defaultSectionId
                  ? <BoardUnpinDropZone sectionId={projection.defaultSectionId} />
                  : null}
              </div>
            )}
          {roster.isSuccess && pinnedRows.length === 0 && listRows.length === 0 ? (
            <p className="px-2 py-6 text-center text-body-2-medium text-text-tertiary">
              {hasQuery ? t("appSidebar.noResultsFor", { query: query.trim() }) : t("appSidebar.noBotsYet")}
            </p>
          ) : null}
        </nav>
      </div>

      <footer className={cn("flex shrink-0 flex-col gap-1", dense ? "mt-1.5" : "mt-3")}>
        <ConnectorUpgradeSidebarLink className={FOOTER_BUTTON} onNavigate={closeDrawer} />
        {(!dense || accountLayout === "base") ? (
          <div className={dense ? undefined : "mt-2"}>
            <AccountMenu />
          </div>
        ) : null}
      </footer>
      </div>

      {creatingGroupMounted ? <GroupDialog open={creatingGroup} onClose={() => setCreatingGroup(false)} /> : null}
    </aside>
    </RosterDragProvider>
  );
}

/**
 * Bureau : l'organisation en tête de barre. Quand le compte a plusieurs
 * espaces (`useWorkspaceSwitch`, les règles de `WorkspaceSelector`), elle
 * devient le sélecteur de la maquette, avec son chevron haut / bas ; sinon un
 * simple nom, sans chevron qui ne mènerait nulle part.
 */
/**
 * L'organisation (et son sélecteur d'espace) en tête de la barre du haut,
 * barre latérale ouverte. Sa largeur suit le nom : le repli et la navigation
 * viennent juste après, sans vide.
 */
export function OrganizationHead({ name: fixedName }: { name?: string } = {}) {
  const { t } = useT();
  // The agency frame names the agency, whichever client is being operated. In
  // a personal account the account card is the identity: no organization name.
  const identity = useOperatorIdentity();
  const userId = readCloudSession()?.userId;
  const known = identity.signedIn ? (identity.personal ? identity.name : identity.organizationName) : "";
  // Until `/api/auth/me` answers the head would be empty: the label recorded
  // on the last visit stands in (`lib/boot-identity.ts`).
  const name = fixedName ?? (known || readBootIdentityLabel(userId) || "");
  useEffect(() => {
    if (!fixedName && known) rememberBootIdentity(userId, known);
  }, [fixedName, known, userId]);
  const workspaceSwitch = useWorkspaceSwitch();
  const [open, setOpen] = useState(false);
  const face = <BotFace name={name || "openedbot"} seed="ohb-organization" face={null} animated={false} className="size-[18px] shrink-0" />;
  if (!workspaceSwitch) {
    return (
      <p className="flex h-[30px] min-w-0 items-center gap-2 px-1.5 text-body-2-medium font-semibold text-text-primary">
        {face}
        <span className="truncate">{name}</span>
      </p>
    );
  }
  return (
    <div className="flex min-w-0">
      <BuiPopover open={open} onOpenChange={setOpen}>
        <BuiPopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("fleet.chooseWorkspace")}
            title={t("fleet.chooseWorkspace")}
            className="flex h-8 min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-lg ps-1.5 pe-2 text-body-2-medium font-semibold text-text-primary outline-none transition-colors hover:bg-board-row-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            {face}
            <span className="truncate">{name}</span>
            <RiExpandUpDownLine aria-hidden className="size-3.5 shrink-0 text-foreground-icon-tertiary" />
          </button>
        </BuiPopoverTrigger>
        <BuiPopoverContent align="start" sideOffset={4} className="w-[240px] gap-1" aria-label={t("fleet.chooseWorkspace")}>
          {workspaceSwitch.groups.map((group) => (
            <div key={group.label} role="group" aria-label={t(group.label)} className="flex flex-col">
              <p className="px-2 pt-1.5 pb-1 text-[12px] text-text-tertiary">{t(group.label)}</p>
              {group.workspaces.map((workspace) => {
                const current = workspace.id === workspaceSwitch.activeId;
                return (
                  <button
                    key={workspace.id}
                    type="button"
                    aria-current={current ? "true" : undefined}
                    onClick={() => { setOpen(false); if (!current) workspaceSwitch.open(workspace); }}
                    className={BUI_PANEL_ITEM}
                  >
                    <span className="min-w-0 flex-1 truncate text-body-medium text-text-primary">{workspace.name}</span>
                    {current ? <RiCheckLine aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" /> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </BuiPopoverContent>
      </BuiPopover>
    </div>
  );
}

type ChatRowSlot = { sectionId: string; index: number; quiet?: boolean };

type ChatRowContext = {
  routeBotId: string | undefined;
  groupId: string | undefined;
  operator: OperatorProfileDto | null;
  renamingId: string | null;
  onRename: (botId: string) => void;
  onRenameDone: () => void;
  onNavigate: () => void;
  slot?: ChatRowSlot;
  /** Bureau : les lignes serrées de la maquette. */
  dense?: boolean;
};

function renderChatRow(row: RosterRow, ctx: ChatRowContext) {
  if (row.kind === "bot") {
    return (
      <BotListRow
        key={row.bot.id}
        bot={row.bot}
        active={row.bot.id === ctx.routeBotId}
        operator={ctx.operator}
        renaming={ctx.renamingId === row.bot.id}
        onRename={ctx.onRename}
        onRenameDone={ctx.onRenameDone}
        onNavigate={ctx.onNavigate}
        slot={ctx.slot}
        dense={ctx.dense}
      />
    );
  }
  return (
    <GroupListRow
      key={row.group.id}
      group={row.group}
      active={row.group.id === ctx.groupId}
      operator={ctx.operator}
      onNavigate={ctx.onNavigate}
      slot={ctx.slot}
      dense={ctx.dense}
    />
  );
}

/**
 * La zone « Désépingler », visible seulement pendant le drag d'un épinglé quand
 * la liste plate est vide : sans elle, la liste (seule cible, 0 px de haut)
 * n'offrait aucun endroit où lâcher la tuile pour la remettre dans la liste.
 */
function BoardUnpinDropZone({ sectionId }: { sectionId: string }) {
  const { t } = useT();
  const { dragging } = useRosterDrag();
  const pinnedDrag = dragging
    ? (dragging.row.kind === "bot" ? dragging.row.bot.pinned : dragging.row.group.pinned === true)
    : false;
  if (!dragging || !pinnedDrag) return null;
  const over = dragging.over === sectionId;
  return (
    <div
      data-drop-section={sectionId}
      className={cn(
        "flex h-16 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-border-button-white px-3 text-center text-body-2-medium text-text-tertiary",
        over && "border-text-secondary bg-background-tertiary-hover text-text-primary",
      )}
    >
      {t("appSidebar.dropToUnpin")}
    </div>
  );
}

/** La zone « Épingler », visible seulement pendant un drag, quand le rail est vide. */
function BoardPinDropZone() {
  const { t } = useT();
  const { dragging } = useRosterDrag();
  if (!dragging) return null;
  const over = dragging.over === PINNED_DROP_ID;
  return (
    <div
      data-drop-section={PINNED_DROP_ID}
      className={cn(
        "flex h-16 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-border-button-white px-3 text-center text-body-2-medium text-text-tertiary",
        over && "border-text-secondary bg-background-tertiary-hover text-text-primary",
      )}
    >
      {t("appSidebar.dropToPin")}
    </div>
  );
}

/** Le rail d'épingles est lui-même la cible quand il est peuplé. */
function PinRail({ children }: { children: React.ReactNode }) {
  const { t } = useT();
  const { dragging } = useRosterDrag();
  const over = dragging?.over === PINNED_DROP_ID;
  return (
    <ul
      aria-label={t("appSidebar.pinnedGroup")}
      data-drop-section={PINNED_DROP_ID}
      className={cn(
        "flex shrink-0 flex-wrap justify-center gap-x-3 gap-y-3 rounded-xl px-1 pt-2 pb-3",
        over && "bg-background-tertiary-hover",
      )}
    >
      {children}
    </ul>
  );
}

function BoardSectionBlock({
  section,
  label,
  onToggle,
  routeBotId,
  groupId,
  operator,
  renamingId,
  onRename,
  onRenameDone,
  onNavigate,
  dense = false,
}: {
  section: RosterSectionProjection<RosterRow>;
  label: string;
  onToggle: () => void;
  routeBotId: string | undefined;
  groupId: string | undefined;
  operator: OperatorProfileDto | null;
  renamingId: string | null;
  onRename: (botId: string) => void;
  onRenameDone: () => void;
  onNavigate: () => void;
  dense?: boolean;
}) {
  const { t } = useT();
  const { dragging } = useRosterDrag();
  const over = dragging?.over === section.id;
  const draggedId = dragging
    ? (dragging.row.kind === "bot" ? dragging.row.bot.id : dragging.row.group.id)
    : null;
  const draggedIndex = draggedId === null
    ? -1
    : section.rows.findIndex((row) => (row.kind === "bot" ? row.bot.id : row.group.id) === draggedId && row.kind === dragging?.row.kind);
  const pinnedDrag = dragging
    ? (dragging.row.kind === "bot" ? dragging.row.bot.pinned : dragging.row.group.pinned === true)
    : false;
  const quietAt = (index: number) => !pinnedDrag && draggedIndex !== -1 && (index === draggedIndex || index === draggedIndex + 1);
  const ctx = { routeBotId, groupId, operator, renamingId, onRename, onRenameDone, onNavigate, dense };
  return (
    <div data-drop-section={section.id} className={cn("flex flex-col rounded-xl", dense ? "gap-0.5" : "gap-1", over && "bg-background-tertiary-default")}>
      <BoardSectionHeader label={label} collapsed={section.collapsed} count={section.rows.length} onToggle={onToggle} dense={dense} />
      {section.collapsed ? null : section.rows.length === 0 ? (
        <p className={cn(dense ? "px-2.5 py-1.5 text-[12px] text-text-tertiary" : "px-2 py-2 text-body-2-medium text-text-tertiary", dragging && "min-h-12")}>{t("appSidebar.emptySection")}</p>
      ) : (
        <div className={cn("flex flex-col", dense ? "gap-0.5" : "gap-2")}>
          {section.rows.map((row, index) => renderChatRow(row, { ...ctx, slot: { sectionId: section.id, index, quiet: quietAt(index) } }))}
          <div aria-hidden className="relative h-0">
            <RosterInsertionLine sectionId={section.id} index={section.rows.length} quiet={quietAt(section.rows.length)} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * L'intitulé d'une liste au bureau, l'en-tête de section de Grok Bot
 * (`sectionHeader`) : 30 px, marges 8 / 8 / 6, texte 13/18 gris, graisse
 * normale, aligné sur le texte des lignes (8 px).
 */
export const SECTION_LABEL_DENSE = "flex h-[30px] shrink-0 items-center px-2 pt-2 pb-1.5 text-[13px] leading-[18px] font-normal text-text-section-label";

/** En-tête de dossier : clic pour replier. Le hover souris est le même cran que les tuiles. */
function BoardSectionHeader({
  label,
  collapsed,
  count,
  onToggle,
  dense = false,
}: {
  label: string;
  collapsed: boolean;
  count: number;
  onToggle: () => void;
  dense?: boolean;
}) {
  if (dense) {
    // Bureau : l'intitulé de la maquette, toujours repliable. Le chevron suit
    // le nom au lieu de le précéder, pour que le nom reste aligné sur les
    // lignes ; il ne paraît qu'au survol, au focus ou replié.
    return (
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className={cn(SECTION_LABEL_DENSE, "group w-full min-w-0 cursor-pointer gap-0.5 rounded-lg outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring")}
      >
        <span className="min-w-0 truncate text-left">{label}</span>
        <RiArrowRightSLine
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-[transform,opacity]",
            collapsed ? "opacity-100" : "rotate-90 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
          )}
        />
        {collapsed ? <span className="ms-auto tabular-nums">{count}</span> : null}
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-1 rounded-xl px-2 text-body-2-medium text-text-tertiary outline-none hover:bg-background-tertiary-hover hover:text-text-secondary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
    >
      <RiArrowRightSLine className={cn("size-4 shrink-0 transition-transform", !collapsed && "rotate-90")} />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {collapsed ? <span className="tabular-nums">{count}</span> : null}
    </button>
  );
}

const ROW_CLASS =
  "flex h-[54px] shrink-0 items-center gap-2.5 rounded-xl p-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring";

/**
 * Bureau : la ligne de Bot de Grok Bot (`expanded`) : 54 px, marges de 8 px,
 * visage de 36 px à 8 px du texte, rayon de 10 px.
 */
const ROW_DENSE =
  "flex h-[54px] shrink-0 items-center gap-2 rounded-lg p-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring";

/** Le fond d'une ligne de fil selon la barre (bureau ou tiroir) et la page ouverte. */
function rowSurface(dense: boolean, active: boolean): string {
  if (dense) return active ? "bg-board-row-active" : "hover:bg-board-row-hover";
  return active ? "bg-background-tertiary-default" : "hover:bg-background-secondary-hover";
}

const PIN_TILE =
  "flex w-full flex-col items-center gap-1.5 rounded-2xl px-1 py-1.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring";

/**
 * Pastille d'état sur le coin bas droit du visage, comme le rail d'épingles
 * de Grok Bot : le point bleu (non lu) mord le bord de la forme.
 */
function PinStatus({ running, unread, awaiting }: { running?: boolean; unread?: boolean; awaiting?: boolean }) {
  const { t } = useT();
  if (!running && !unread && !awaiting) return null;
  return (
    <span className="absolute -right-0.5 -bottom-0.5 flex">
      {running ? (
        <span role="status" aria-label={t("appSidebar.running")} className="bui-breathing-dot size-2.5 rounded-full bg-accent-500 ring-2 ring-background-secondary-default" />
      ) : unread ? (
        <span role="status" aria-label={t("appSidebar.unread")} className="size-2.5 rounded-full bg-accent-500 ring-2 ring-background-secondary-default" />
      ) : null}
      {awaiting ? (
        <span role="status" aria-label={t("appSidebar.awaitingApproval")} className="size-2.5 rounded-full bg-warn-700 ring-2 ring-background-secondary-default" />
      ) : null}
    </span>
  );
}

/**
 * Un épinglé : visage en grand, nom dessous, plus de ligne dans la liste.
 * Le menu contextuel est celui de la ligne (désépingler compris).
 */
const PinnedTile = memo(function PinnedTile({
  row,
  active,
  renaming,
  onRename,
  onRenameDone,
  onNavigate,
}: {
  row: RosterRow;
  active: boolean;
  renaming: boolean;
  onRename: (botId: string) => void;
  onRenameDone: () => void;
  onNavigate: () => void;
}) {
  const { dragging, pointerDownFor } = useRosterDrag();
  if (row.kind === "bot" && renaming) {
    // Un épinglé se renomme dans la ligne de la liste du tiroir : la tuile n'a
    // pas la place d'un champ.
    return (
      <li className="basis-full">
        <RenameRow bot={row.bot} onDone={onRenameDone} />
      </li>
    );
  }
  const lifted = dragging !== null && dragging.row.kind === row.kind
    && (dragging.row.kind === "bot" ? dragging.row.bot.id : dragging.row.group.id) === (row.kind === "bot" ? row.bot.id : row.group.id);
  const className = cn(
    PIN_TILE,
    active && "bg-background-tertiary-default",
    "hover:bg-background-tertiary-hover",
    lifted && "opacity-40",
  );
  const onPointerDown = pointerDownFor?.(row);
  if (row.kind === "bot") {
    const bot = row.bot;
    return (
      <li className="w-[7.25rem]">
        <BotContextMenu bot={bot} onRename={() => onRename(bot.id)}>
          <Link
            to="/bot/$botId"
            params={{ botId: bot.id }}
            draggable={false}
            title={bot.name}
            aria-current={active ? "page" : undefined}
            aria-haspopup="menu"
            onPointerDown={onPointerDown}
            onClick={onNavigate}
            className={className}
          >
            <span className="relative">
              <BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-16" />
              <PinStatus running={bot.running} unread={bot.unread} awaiting={bot.awaitingApproval} />
            </span>
            <span className="w-full truncate text-body-2-medium text-text-primary">{bot.name}</span>
          </Link>
        </BotContextMenu>
      </li>
    );
  }
  const group = row.group;
  return (
    <li className="w-[7.25rem]">
      <GroupContextMenu group={group}>
        <Link
          to="/g/$groupId"
          params={{ groupId: group.id }}
          draggable={false}
          title={group.name}
          aria-current={active ? "page" : undefined}
          aria-haspopup="menu"
          onPointerDown={onPointerDown}
          onClick={onNavigate}
          className={className}
        >
          <span className="relative">
            <GroupFaceStack members={group.members} size="size-8" className="size-16 justify-center" />
            <PinStatus running={group.running} unread={group.unread} awaiting={group.awaitingApproval || group.needsYou} />
          </span>
          <span className="w-full truncate text-body-2-medium text-text-primary">{group.name}</span>
        </Link>
      </GroupContextMenu>
    </li>
  );
});

/**
 * Bureau : la colonne droite d'une ligne, l'heure de la dernière activité en
 * haut (comme la maquette) et les pastilles d'état dessous.
 */
function RowMeta({ at, running, unread, awaiting }: { at: string; running?: boolean; unread?: boolean; awaiting?: boolean }) {
  const { locale } = useT();
  const time = formatListTime(locale, at);
  return (
    <span className="flex shrink-0 flex-col items-end gap-1 self-stretch pt-px">
      {time ? (
        <time dateTime={at} className="text-[12px] leading-4 whitespace-nowrap text-text-tertiary tabular-nums">{time}</time>
      ) : null}
      <RowStatus running={running} unread={unread} awaiting={awaiting} inline />
    </span>
  );
}

export function RowStatus({ running, unread, awaiting, inline = false }: { running?: boolean; unread?: boolean; awaiting?: boolean; inline?: boolean }) {
  const { t } = useT();
  if (!running && !unread && !awaiting) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-1", inline ? "h-2" : "self-center pe-1")}>
      {running ? <span role="status" aria-label={t("appSidebar.running")} className="bui-breathing-dot size-2 rounded-full bg-accent-500" /> : null}
      {awaiting ? <span role="status" aria-label={t("appSidebar.awaitingApproval")} className="size-2 rounded-full bg-warn-700" /> : null}
      {unread && !running ? <span role="status" aria-label={t("appSidebar.unread")} className="size-2 rounded-full bg-accent-500" /> : null}
    </span>
  );
}

/**
 * `memo`: a roster patch rebuilds the bar, but structural sharing keeps every
 * untouched `BotDto`, so only the patched row (and its context menu) renders.
 */
const BotListRow = memo(function BotListRow({
  bot,
  active,
  operator,
  renaming,
  onRename,
  onRenameDone,
  onNavigate,
  slot,
  dense = false,
}: {
  bot: BotDto;
  active: boolean;
  operator: OperatorProfileDto | null;
  renaming: boolean;
  onRename: (botId: string) => void;
  onRenameDone: () => void;
  onNavigate: () => void;
  slot?: ChatRowSlot;
  dense?: boolean;
}) {
  const { t } = useT();
  const { pointerDownFor } = useRosterDrag();
  const preview = bot.running
    ? t("boardui.thinkingTogether")
    : bot.preview
      ? stripHandlePrefix(bot.preview, operator)
      : t("appSidebar.noPreview");
  if (renaming) return <RenameRow bot={bot} onDone={onRenameDone} dense={dense} />;
  return (
    <div className="relative" {...(slot ? rosterRowAttributes(slot.sectionId, slot.index) : {})}>
      {slot ? <RosterInsertionLine sectionId={slot.sectionId} index={slot.index} quiet={slot.quiet} /> : null}
    <BotContextMenu bot={bot} onRename={() => onRename(bot.id)}>
      <Link
        to="/bot/$botId"
        params={{ botId: bot.id }}
        draggable={false}
        aria-current={active ? "page" : undefined}
        aria-haspopup="menu"
        onPointerDown={pointerDownFor?.({ kind: "bot", bot })}
        onClick={onNavigate}
        className={cn(dense ? ROW_DENSE : ROW_CLASS, rowSurface(dense, active))}
      >
        <BotFace name={bot.name} seed={bot.id} face={bot.face} className={dense ? "size-9" : "size-10"} />
        {dense ? (
          <>
            <RowTitle name={bot.name} preview={preview} unread={bot.unread} />
            <RowMeta at={bot.lastActivityAt} running={bot.running} unread={bot.unread} awaiting={bot.awaitingApproval} />
          </>
        ) : (
          <>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-body-medium text-text-primary">{bot.name}</span>
              <span className={cn("truncate text-body-regular", bot.unread ? "text-text-secondary" : "text-text-tertiary")}>{preview}</span>
            </span>
            <RowStatus running={bot.running} unread={bot.unread} awaiting={bot.awaitingApproval} />
          </>
        )}
      </Link>
    </BotContextMenu>
    </div>
  );
});

const GroupListRow = memo(function GroupListRow({
  group,
  active,
  operator,
  onNavigate,
  slot,
  dense = false,
}: {
  group: GroupDto;
  active: boolean;
  operator: OperatorProfileDto | null;
  onNavigate: () => void;
  slot?: ChatRowSlot;
  dense?: boolean;
}) {
  const { t } = useT();
  const { pointerDownFor } = useRosterDrag();
  const preview = group.running
    ? t("boardui.thinkingTogether")
    : group.preview
      ? stripHandlePrefix(group.preview, operator)
      : t("appSidebar.noPreview");
  return (
    <div className="relative" {...(slot ? rosterRowAttributes(slot.sectionId, slot.index) : {})}>
      {slot ? <RosterInsertionLine sectionId={slot.sectionId} index={slot.index} quiet={slot.quiet} /> : null}
    <GroupContextMenu group={group}>
      <Link
        to="/g/$groupId"
        params={{ groupId: group.id }}
        draggable={false}
        aria-current={active ? "page" : undefined}
        aria-haspopup="menu"
        onPointerDown={pointerDownFor?.({ kind: "group", group })}
        onClick={onNavigate}
        className={cn(dense ? ROW_DENSE : ROW_CLASS, rowSurface(dense, active))}
      >
        {dense ? (
          <>
            <GroupFaceStack members={group.members} size="size-[22px]" className="size-9 shrink-0 justify-center" />
            <RowTitle name={group.name} preview={preview} unread={group.unread} />
            <RowMeta at={group.lastActivityAt} running={group.running} unread={group.unread} awaiting={group.awaitingApproval || group.needsYou} />
          </>
        ) : (
          <>
            <GroupFaceStack members={group.members} size="size-6" className="size-10 shrink-0 justify-center" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-body-medium text-text-primary">{group.name}</span>
              <span className={cn("truncate text-body-regular", group.unread ? "text-text-secondary" : "text-text-tertiary")}>{preview}</span>
            </span>
            <RowStatus running={group.running} unread={group.unread} awaiting={group.awaitingApproval || group.needsYou} />
          </>
        )}
      </Link>
    </GroupContextMenu>
    </div>
  );
});

/**
 * Bureau : le nom (14/20, medium) et le dernier message (13/18, gris
 * secondaire), les `body1` et `body2` de Grok Bot. Un non-lu remonte d'un
 * cran, au texte principal.
 */
function RowTitle({ name, preview, unread }: { name: string; preview: string; unread?: boolean }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-[14px] leading-5 font-medium text-text-primary">{name}</span>
      <span className={cn("truncate text-[13px] leading-[18px]", unread ? "text-text-primary" : "text-text-secondary")}>{preview}</span>
    </span>
  );
}

/** « Renommer le chat » : la ligne devient un champ, Entrée valide, Échap annule. */
function RenameRow({ bot, onDone, dense = false }: { bot: BotDto; onDone: () => void; dense?: boolean }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState(bot.name);
  const rename = useMutation({
    mutationFn: (next: string) => api.updateBot(bot.id, { name: next }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      onDone();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t("botContextMenu.actionFailed")),
  });
  const commit = () => {
    const next = name.trim();
    if (!next || next === bot.name) return onDone();
    rename.mutate(next);
  };
  return (
    <div className={cn(dense ? ROW_DENSE : ROW_CLASS, rowSurface(dense, true))}>
      <BotFace name={bot.name} seed={bot.id} face={bot.face} className={dense ? "size-9" : "size-10"} />
      <input
        autoFocus
        value={name}
        maxLength={48}
        disabled={rename.isPending}
        aria-label={t("boardui.renameChat")}
        onChange={(event) => setName(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") onDone();
        }}
        className={cn(
          "min-w-0 flex-1 rounded-2lg bg-background-primary-default px-2 text-text-primary outline-none ring-2 ring-border-focus-ring",
          dense ? "h-7 text-[13px]" : "h-8 text-body-medium",
        )}
      />
    </div>
  );
}

