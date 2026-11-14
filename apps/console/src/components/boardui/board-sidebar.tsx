import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useJustCreatedBot, useRouteBotParams } from "../../lib/bots/pending-bot-creations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RiAddFill,
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
import { partitionThreadVisibility } from "@/lib/thread/thread-visibility";
import { ApiError, api, queryKeys } from "../../lib/api";
import { registerSpeechRates } from "../../lib/voice/speech-rates";
import { useT } from "../../lib/i18n";
import { BotContextMenu } from "../bot-context-menu";
import { BotFace } from "../bot-face";
import { GroupContextMenu } from "../group-context-menu";
import { GroupFaceStack } from "../group-face-stack";
import { useNewBot } from "../../lib/bots/use-new-bot";
import { useMobileDrawer } from "../mobile/mobile-drawer-shell";
import { ConnectorUpgradeSidebarLink } from "../dashboard/connector-upgrade-badge";
import { useOperatorIdentity } from "../../lib/session/operator-identity";
import { useWorkspaceSwitch } from "../workspace/workspace-navigation";
import { AccountMenu, AccountUpdatePill } from "./account-menu";
import { BUI_PANEL_ITEM, BuiCloseGlyph, BuiPopover, BuiPopoverContent, BuiPopoverTrigger } from "./menu";
import { COLLAPSE_MOTION, CreateMenu, useBoardChrome } from "./board-chrome";
import { useRosterSections } from "../dashboard/use-roster-sections";
import { PINNED_DROP_ID, RosterDragProvider, isPinnedRow, rosterRowAttributes, useRosterDrag, useRosterDragHandles, useRosterDragPhase, type RosterDragRow, type RosterDropSlot } from "../dashboard/roster-drag";
import { BoardPinDropZone, BoardUnpinDropZone, PinRail, PinnedTile, comparePinned } from "./board-pins";
import { RosterInsertionLine } from "../dashboard/roster-section";
import { BoardSectionHeader, SECTION_LABEL_DENSE } from "./board-section-header";

export { SECTION_LABEL_DENSE };
import { RosterSkeleton } from "../skeletons/frame-skeletons";
import { useSecondaryReadsReady } from "../../lib/shell/after-first-paint";
import { rememberBootSidebarShape } from "../../lib/session/boot-shape";
import { readBootIdentityLabel, rememberBootIdentity } from "../../lib/session/boot-identity";
import { readCloudSession } from "../../lib/session/cloud-session";
import { useAccountLayout } from "../../lib/shell/account-layout";
import { BOARD_SIDEBAR_CARD } from "./board-sidebar-card";
import { RailFooter } from "./board-rails";
import { RailCardHead } from "./board-rail-head";
import { SAFETY_NET_REFRESH_MS } from "../../lib/stream/organization-projection";

type RosterRow = { kind: "bot"; bot: BotDto } | { kind: "group"; group: GroupDto };

const activityOf = (row: RosterRow) => (row.kind === "bot" ? row.bot.lastActivityAt : row.group.lastActivityAt);

const NO_GROUPS: GroupDto[] = [];
const NO_SECTIONS: SectionDto[] = [];

/**
 * What the bar reads from the roster. Not `cursor`, which every SSE flush
 * advances. `sections` stays: a created folder (Fly, …) must repaint the
 * bar even if no row has moved. react-query's structural sharing
 * keeps the reference of an untouched row, so its `memo` holds.
 */
function selectSidebarRoster(roster: RosterDto) {
  return {
    bots: roster.bots,
    groups: roster.groups ?? NO_GROUPS,
    sections: roster.sections ?? NO_SECTIONS,
    operator: roster.operator ?? null,
  };
}

/** The top row's round buttons: search. */
const TOP_BUTTON =
  "button-press-motion inline-flex h-9 w-full min-w-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-0 bg-background-tertiary-default p-2 text-foreground-icon-secondary shadow-none outline-none select-none hover:bg-background-tertiary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 active:bg-background-tertiary-hover";

/**
 * The desktop navigation links (Salon, Inbox), under the top
 * row: 32 px, a 16 px icon in grey, the card's hover grey, and
 * for the open page (`aria-current`, set by `Link`) the blue gradient of the
 * active link in the « Chat Starter » template, text and icon in white. The
 * gradient is set as an arbitrary property: `bg-button-primary` is a
 * CSS class (boardui.css), not a theme colour, and takes no
 * variant.
 */
export const NAV_ROW =
  "flex h-8 shrink-0 items-center gap-2.5 rounded-2lg px-2.5 text-[13px] leading-[18px] font-medium text-text-primary outline-none openedbot-row hover:bg-board-row-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring aria-[current=page]:[background-image:var(--bui-gradient-primary)] aria-[current=page]:text-text-white [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-foreground-icon-secondary aria-[current=page]:[&>svg]:text-text-white aria-[current=page]:[&>span]:text-text-white";

/** The links at the foot of the bar: ghost icon buttons, aligned to the left. */
export const FOOTER_BUTTON =
  "button-press-motion inline-flex h-9 cursor-pointer items-center justify-start gap-0.5 overflow-hidden whitespace-nowrap rounded-2lg bg-transparent p-2 text-body-medium text-text-secondary outline-none select-none hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 active:bg-background-secondary-hover";

/**
 * The conversations bar of the BoardUI « Multi-agent Chat » template.
 *
 * On desktop (`dense`): the organization and the collapse in the 46 px row
 * on the frame background, then the grey card of the « Chat Starter » template
 * with the top row (search that stretches the full width,
 * « + »), the Salon and Inbox links, then the thread list in rows of
 * 44 px (28 px face, name, last message, time of the last
 * activity) and the account row. In the mobile drawer, the original 260 px
 * card: 54 px rows (40 px face) and an account card.
 * Settings lives in the account menu.
 *
 * Pins do not stay as one more row at the head of the list. As
 * in the reference app, they leave the list and show as tiles (face
 * large, name underneath, badge at the bottom-right corner) centred under the
 * top row. The rest sorts into the roster sections (Fly,
 * then « Non assignés » last). While there is only the default
 * section, the list stays flat.
 *
 * With the mouse, a row is picked up and dropped: into a section (reorder
 * or folder change) or onto the pins rail. The finger goes through
 * « Déplacer vers… ».
 */
export function BoardSidebar({ className }: { className?: string }) {
  const { t } = useT();
  const navigate = useNavigate();
  const { botId: routeBotId, groupId } = useRouteBotParams();
  const mobileDrawer = useMobileDrawer();
  // Desktop: the mockup's bar. The mobile drawer keeps its own.
  const dense = !mobileDrawer;
  const requestedAccountLayout = useAccountLayout();
  const accountLayout = dense ? requestedAccountLayout : "base";
  // Variant C: the card carries what the icon rail held (board-rails.tsx): at
  // its head the logo or the traffic lights, the collapse, Home and Inbox; a
  // permanent search field under it; at its foot the quotas and Settings.
  const railShell = accountLayout === "c";
  // The Inbox count, as in `account-menu.tsx`: invalidated by the shell's stream, a slow safety net.
  const secondaryReady = useSecondaryReadsReady();
  const inboxCount = useQuery({
    queryKey: queryKeys.inbox,
    queryFn: api.inbox,
    refetchInterval: SAFETY_NET_REFRESH_MS,
    refetchOnReconnect: true,
    enabled: dense && secondaryReady,
    select: (inbox) => inbox.counts.total,
  }).data ?? 0;
  // The setter alone: reading the whole store re-rendered the bar on every `setTab`.
  const roster = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    refetchInterval: SAFETY_NET_REFRESH_MS,
    refetchOnReconnect: true,
    select: selectSidebarRoster,
  });
  const sectionActions = useRosterSections();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const openCreateBot = useNewBot();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  const allBots = roster.data?.bots ?? [];
  const bots = useMemo(
    () => partitionThreadVisibility(allBots).visible.filter((bot) => bot.archivedAt == null),
    [allBots],
  );
  const allGroups = roster.data?.groups ?? NO_GROUPS;
  const groups = useMemo(() => partitionThreadVisibility(allGroups).visible, [allGroups]);
  const hasQuery = normalizeRosterQuery(query).length > 0;
  // Variant C: the magnifier unfolds into the field while it is in use.
  const searchShown = searchOpen || hasQuery;
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
    pinnedRows.sort(comparePinned);
    listRows.sort(byActivity);
    return { pinnedRows, listRows };
  }, [bots, groups, query]);
  const sections = roster.data?.sections ?? NO_SECTIONS;
  // Pins stay in the rail: they do not reappear under Fly.
  // A search flattens: empty headers do not help find a row.
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
  // The flat list (« Non assignés ») collapses too: into the section read if
  // it exists (state kept), otherwise for the session.
  const flatSection = projection.sections[0] ?? null;
  const [flatLocalCollapsed, setFlatLocalCollapsed] = useState(false);
  const flatCollapsed = flatSection ? flatSection.collapsed : flatLocalCollapsed;
  const flatOpenClass = useSectionOpenClass(flatCollapsed && dense && !hasQuery);
  const toggleFlat = () => {
    if (flatSection) void sectionActions.setCollapsed(flatSection.id, !flatSection.collapsed);
    else setFlatLocalCollapsed((value) => !value);
  };
  // The flat list follows the manual rank (`position`), the one drag-
  // and-drop writes: sorted by activity, a drop would have changed nothing
  // on screen. A search keeps the activity order, and does not drag.
  const flatRows = hasQuery ? listRows : projection.sections[0]?.rows ?? listRows;

  // The next refresh draws its loading states with this roster's shape
  // (`lib/session/boot-shape.ts`): pinned tiles, section labels and row counts.
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
  // Bar collapsed, the top bar keeps search and the « + »: it
  // asks for them here, where the field and the creation dialogs live.
  const request = useBoardChrome((state) => state.request);
  // Desktop only: the mobile drawer does not collapse.
  const collapsed = useBoardChrome((state) => state.collapsed) && dense;
  useEffect(() => {
    if (!request) return;
    if (request.kind === "search") setSearchOpen(true);
    if (request.kind === "createBot") openCreateBot();
    // The group is composed as in the reference app: « À : » and badges (`/g/new`).
    if (request.kind === "createGroup") {
      void navigate({ to: "/g/new" });
      closeDrawer();
    }
  }, [request]);
  // The bar is mounted on every screen (desktop and drawer): it is what
  // keeps the reading speed per bot up to date for every thread.
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
      if (sectionId === PINNED_DROP_ID) return pinnedRows;
      if (showSections) return projection.sections.find((section) => section.id === sectionId)?.rows ?? [];
      return flatRows;
    });
    const name = row.kind === "bot" ? row.bot.name : row.group.name;
    if (target === PINNED_DROP_ID) return t("appSidebar.dragAnnouncePinned", { name });
    const section = projection.sections.find((candidate) => candidate.id === target);
    const label = !section || section.locked ? t("appSidebar.unassigned") : section.name;
    return t(isPinnedRow(row) ? "appSidebar.dragAnnounceUnpinned" : "appSidebar.dragAnnounceMoved", { name, section: label });
  }, [flatRows, pinnedRows, projection.sections, sectionActions, showSections, t]);
  const editableSectionIds = useMemo(
    () => projection.sections.filter((section) => !section.locked).map((section) => section.id),
    [projection.sections],
  );
  const onSectionDrop = useCallback((sectionId: string, index: number) => {
    void sectionActions.reorderSection(sectionId, index, editableSectionIds);
  }, [editableSectionIds, sectionActions]);

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
    <RosterDragProvider enabled={!hasQuery} onDrop={onRosterDrop} onSectionDrop={showSections ? onSectionDrop : undefined}>
    <aside
      aria-label={t("appSidebar.navigationLabel")}
      className={cn(
        // Desktop: the grey card of the « Chat Starter » template
        // (`BOARD_SIDEBAR_CARD`), under the frame's top bar which carries
        // the organization and the collapse (`BoardTopBar`). The mobile drawer is
        // this card in full.
        mobileDrawer
          ? "isolate flex h-full min-h-0 w-[260px] shrink-0 flex-col rounded-3xl border border-border-button-white bg-background-secondary-default p-[7px] text-text-primary shadow-bui-sidebar"
          : cn(
            // The boardui.com collapse: while the column closes
            // (board-frame.tsx), the content fades with a slight blur, on
            // the same timing. Open, no filter: the text stays sharp.
            "isolate flex h-full min-h-0 w-[272px] shrink-0 flex-col text-text-primary transition-[opacity,filter]",
            "ps-3 pb-3",
            COLLAPSE_MOTION,
            collapsed ? "opacity-0 [filter:blur(3px)]" : "opacity-100",
          ),
        className,
      )}
    >
      <div className={dense ? BOARD_SIDEBAR_CARD : "contents"}>
      {railShell ? (
        <RailCardHead
          searchShown={searchShown}
          inputRef={searchInput}
          query={query}
          hasQuery={hasQuery}
          onQuery={setQuery}
          onKeyDown={onSearchKey}
          onOpenChange={setSearchOpen}
          onCloseSearch={closeSearch}
          onCreate={() => openCreateBot()}
        />
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
                  className="flex w-full min-w-0 cursor-pointer items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-secondary hover:bg-background-tertiary-hover hover:text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
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
          <Link to="/settings/inbox" className={NAV_ROW}>
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
          data-roster-scroll=""
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
            <PinRail
              rows={pinnedRows}
              renderTile={(row) => (row.kind === "bot" && renamingId === row.bot.id ? (
                // A pin is renamed in a row: the tile has no room for a field.
                <li className="basis-full"><RenameRow bot={row.bot} onDone={stopRenaming} /></li>
              ) : (
                <PinnedTile
                  row={row}
                  active={row.kind === "bot" ? row.bot.id === routeBotId : row.group.id === groupId}
                  onRename={setRenamingId}
                  onNavigate={closeDrawer}
                />
              ))}
            />
          ) : (
            <BoardPinDropZone />
          )}
          {showSections
            ? projection.sections.map((section) => (
              <BoardSectionBlock
                key={section.id}
                section={section}
                editableIndex={section.locked ? null : editableSectionIds.indexOf(section.id)}
                editableCount={editableSectionIds.length}
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
                {/* Desktop: the flat list keeps its heading, like « Fils »
                    in the mockup, under the navigation links: these are
                    the threads filed in no section. */}
                {dense && !hasQuery && flatRows.length > 0 ? (
                  <BoardSectionHeader
                    label={t("appSidebar.unassigned")}
                    collapsed={flatCollapsed}
                    count={flatRows.length}
                    onToggle={toggleFlat}
                    dense
                  />
                ) : null}
                {flatRows.length > 0 && !(flatCollapsed && dense && !hasQuery) ? (
                  <div className={flatOpenClass}>
                    <RosterRowList
                      // With no section read, no slot: a drop would have
                      // no section to write.
                      sectionId={hasQuery ? null : projection.defaultSectionId}
                      rows={flatRows}
                      ctx={{
                        routeBotId,
                        groupId,
                        operator,
                        renamingId,
                        onRename: setRenamingId,
                        onRenameDone: stopRenaming,
                        onNavigate: closeDrawer,
                        dense,
                      }}
                    />
                  </div>
                ) : null}
                {flatRows.length === 0 && projection.defaultSectionId
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
        ) : railShell ? <RailFooter /> : <AccountUpdatePill />}
      </footer>
      </div>

    </aside>
    </RosterDragProvider>
  );
}

/**
 * The organization at the head of the top bar, sidebar open. When the account
 * has several spaces (`useWorkspaceSwitch`), it becomes the mockup's selector,
 * with its up / down chevron; otherwise a plain name, with no chevron that
 * would lead nowhere. Its width follows the name: the collapse and the
 * navigation come right after, with no gap.
 */
export function OrganizationHead() {
  const { t } = useT();
  // In a personal account the account card is the identity: no organization name.
  const identity = useOperatorIdentity();
  const userId = readCloudSession()?.userId;
  const known = identity.signedIn ? (identity.personal ? identity.name : identity.organizationName) : "";
  // Until `/api/auth/me` answers the head would be empty: the label recorded
  // on the last visit stands in (`lib/session/boot-identity.ts`).
  const name = known || readBootIdentityLabel(userId) || "";
  useEffect(() => {
    if (known) rememberBootIdentity(userId, known);
  }, [known, userId]);
  const workspaceSwitch = useWorkspaceSwitch();
  const [open, setOpen] = useState(false);
  const face = <BotFace name={name || "openedbot"} seed="openedbot-organization" face={null} animated={false} className="size-[18px] shrink-0" />;
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
            aria-label={t("boardui.chooseWorkspace")}
            title={t("boardui.chooseWorkspace")}
            className="flex h-8 min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-lg ps-1.5 pe-2 text-body-2-medium font-semibold text-text-primary outline-none transition-colors hover:bg-board-row-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            {face}
            <span className="truncate">{name}</span>
            <RiExpandUpDownLine aria-hidden className="size-3.5 shrink-0 text-foreground-icon-tertiary" />
          </button>
        </BuiPopoverTrigger>
        <BuiPopoverContent align="start" sideOffset={4} className="w-[240px] gap-1" aria-label={t("boardui.chooseWorkspace")}>
          {workspaceSwitch.workspaces.map((workspace) => {
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
  /** Desktop: the mockup's tight rows. */
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
        slotSection={ctx.slot?.sectionId}
        slotIndex={ctx.slot?.index}
        slotQuiet={ctx.slot?.quiet}
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
      slotSection={ctx.slot?.sectionId}
      slotIndex={ctx.slot?.index}
      slotQuiet={ctx.slot?.quiet}
      dense={ctx.dense}
    />
  );
}

/**
 * `bui-section-open` for a section the user just unfolded, not for one
 * already open when it mounts: on a reload the rows replace the boot
 * silhouette in place, and the fade-and-slide read as a second load.
 * (The « previous value in state » pattern: no effect, no extra paint.)
 */
export function useSectionOpenClass(collapsed: boolean): string | undefined {
  const [previous, setPrevious] = useState(collapsed);
  const [unfolded, setUnfolded] = useState(false);
  if (previous !== collapsed) {
    setPrevious(collapsed);
    setUnfolded(!collapsed);
  }
  return unfolded ? "bui-section-open" : undefined;
}

/**
 * A section's rows, each a drop slot (`data-roster-index`),
 * plus the end stroke: the same list under a section header and in the
 * flat list. `sectionId === null` (search): rows with no slot.
 */
function RosterRowList({ sectionId, rows, ctx }: {
  sectionId: string | null;
  rows: ReadonlyArray<RosterRow>;
  ctx: Omit<ChatRowContext, "slot">;
}) {
  const { dragging } = useRosterDrag();
  const draggedIndex = dragging && sectionId !== null
    ? rows.findIndex((row) => row.kind === dragging.row.kind && (row.kind === "bot" ? row.bot.id : row.group.id) === (dragging.row.kind === "bot" ? dragging.row.bot.id : dragging.row.group.id))
    : -1;
  const pinnedDrag = dragging ? isPinnedRow(dragging.row) : false;
  // Putting the row back in its place moves nothing: both its strokes stay quiet.
  const quietAt = (index: number) => !pinnedDrag && draggedIndex !== -1 && (index === draggedIndex || index === draggedIndex + 1);
  return (
    <div className={cn("flex flex-col", ctx.dense ? "gap-0.5" : "gap-2")}>
      {rows.map((row, index) => renderChatRow(row, sectionId === null ? ctx : { ...ctx, slot: { sectionId, index, quiet: quietAt(index) } }))}
      {sectionId !== null ? (
        <div aria-hidden className="relative h-0">
          <RosterInsertionLine sectionId={sectionId} index={rows.length} quiet={quietAt(rows.length)} />
        </div>
      ) : null}
    </div>
  );
}

function BoardSectionBlock({
  section,
  editableIndex,
  editableCount,
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
  /** Its rank among the sections that can be dragged; `null` for « Non assigné ». */
  editableIndex: number | null;
  editableCount: number;
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
  const { dragging, sectionDrag, sectionPointerDownFor } = useRosterDrag();
  const over = dragging?.over === section.id;
  // The drop stroke of a dragged section (the reference app's `drop-line`): before
  // this section, or after it if it is the last editable one. Silent on
  // the current place of the carried section.
  const sectionLineAt = (index: number) => sectionDrag !== null && sectionDrag.index === index
    && index !== sectionDrag.from && index !== sectionDrag.from + 1;
  const lineBefore = editableIndex !== null && sectionLineAt(editableIndex);
  const lineAfter = editableIndex !== null && editableIndex === editableCount - 1 && sectionLineAt(editableCount);
  const ctx = { routeBotId, groupId, operator, renamingId, onRename, onRenameDone, onNavigate, dense };
  const openClass = useSectionOpenClass(section.collapsed);
  return (
    <div
      data-drop-section={section.id}
      data-section-block={editableIndex === null ? undefined : ""}
      className={cn(
        "relative flex flex-col rounded-xl transition-colors duration-150",
        dense ? "gap-0.5" : "gap-1",
        over && "bg-background-tertiary-default",
        sectionDrag?.sectionId === section.id && "opacity-40",
      )}
    >
      {lineBefore ? <span aria-hidden className="pointer-events-none absolute inset-x-2 -top-[3px] z-10 h-0.5 rounded-full bg-primary" /> : null}
      {lineAfter ? <span aria-hidden className="pointer-events-none absolute inset-x-2 -bottom-[3px] z-10 h-0.5 rounded-full bg-primary" /> : null}
      <BoardSectionHeader
        label={label}
        collapsed={section.collapsed}
        count={section.rows.length}
        onToggle={onToggle}
        onPointerDown={editableIndex === null ? undefined : sectionPointerDownFor?.({ id: section.id, label, from: editableIndex })}
        dense={dense}
      />
      {section.collapsed ? null : section.rows.length === 0 ? (
        <p className={cn(dense ? "px-2.5 py-1.5 text-[12px] text-text-tertiary" : "px-2 py-2 text-body-2-medium text-text-tertiary", dragging && "min-h-12")}>{t("appSidebar.emptySection")}</p>
      ) : (
        <div className={openClass}><RosterRowList sectionId={section.id} rows={section.rows} ctx={ctx} /></div>
      )}
    </div>
  );
}

const ROW_CLASS =
  "flex h-[54px] shrink-0 items-center gap-2.5 rounded-xl p-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring";

/**
 * Desktop: the reference app's Bot row (`expanded`): 54 px, 8 px margins,
 * a 36 px face 8 px from the text, a 10 px radius.
 */
const ROW_DENSE =
  "flex h-[54px] shrink-0 items-center gap-2 rounded-lg p-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring";

/** A thread row's background according to the bar (desktop or drawer) and the open page. */
function rowSurface(dense: boolean, active: boolean): string {
  if (dense) return active ? "bg-board-row-active" : "hover:bg-board-row-hover";
  return active ? "bg-background-tertiary-default" : "hover:bg-background-secondary-hover";
}

/**
 * Desktop: a row's right column, the time of the last activity at
 * the top (like the mockup) and the status badges underneath.
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

function RowStatus({ running, unread, awaiting, inline = false }: { running?: boolean; unread?: boolean; awaiting?: boolean; inline?: boolean }) {
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
  slotSection,
  slotIndex,
  slotQuiet,
  dense = false,
}: {
  bot: BotDto;
  active: boolean;
  operator: OperatorProfileDto | null;
  renaming: boolean;
  onRename: (botId: string) => void;
  onRenameDone: () => void;
  onNavigate: () => void;
  /** The row's slot in its section, as primitives: the `memo` holds during a drag. */
  slotSection?: string;
  slotIndex?: number;
  slotQuiet?: boolean;
  dense?: boolean;
}) {
  const { t } = useT();
  const { pointerDownFor } = useRosterDragHandles();
  const phase = useRosterDragPhase(`bot:${bot.id}`);
  const preview = bot.profileProvisionStatus === "preparing" ? t("botProfileProvision.preparingShort")
    : bot.running ? t("boardui.thinkingTogether")
    : bot.preview ? stripHandlePrefix(bot.preview, operator) : t("appSidebar.noPreview");
  const justCreated = useJustCreatedBot(bot.id);
  if (renaming) return <RenameRow bot={bot} onDone={onRenameDone} dense={dense} />;
  return (
    <div className={cn("relative", justCreated && "bui-row-enter")} {...(slotSection !== undefined && slotIndex !== undefined ? rosterRowAttributes(slotSection, slotIndex) : {})}>
      {slotSection !== undefined && slotIndex !== undefined ? <RosterInsertionLine sectionId={slotSection} index={slotIndex} quiet={slotQuiet} /> : null}
    <BotContextMenu bot={bot} onRename={() => onRename(bot.id)}>
      <Link
        to="/bot/$botId"
        params={{ botId: bot.id }}
        draggable={false}
        aria-current={active ? "page" : undefined}
        aria-haspopup="menu"
        onPointerDown={pointerDownFor?.({ kind: "bot", bot })}
        onClick={onNavigate}
        className={cn(dense ? ROW_DENSE : ROW_CLASS, rowSurface(dense, active), phase === "lifted" && "opacity-40", phase === "landing" && "opacity-0")}
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
  slotSection,
  slotIndex,
  slotQuiet,
  dense = false,
}: {
  group: GroupDto;
  active: boolean;
  operator: OperatorProfileDto | null;
  onNavigate: () => void;
  /** The row's slot in its section, as primitives: the `memo` holds during a drag. */
  slotSection?: string;
  slotIndex?: number;
  slotQuiet?: boolean;
  dense?: boolean;
}) {
  const { t } = useT();
  const { pointerDownFor } = useRosterDragHandles();
  const phase = useRosterDragPhase(`group:${group.id}`);
  const preview = group.running
    ? t("boardui.thinkingTogether")
    : group.preview
      ? stripHandlePrefix(group.preview, operator)
      : t("appSidebar.noPreview");
  return (
    <div className="relative" {...(slotSection !== undefined && slotIndex !== undefined ? rosterRowAttributes(slotSection, slotIndex) : {})}>
      {slotSection !== undefined && slotIndex !== undefined ? <RosterInsertionLine sectionId={slotSection} index={slotIndex} quiet={slotQuiet} /> : null}
    <GroupContextMenu group={group}>
      <Link
        to="/g/$groupId"
        params={{ groupId: group.id }}
        draggable={false}
        aria-current={active ? "page" : undefined}
        aria-haspopup="menu"
        onPointerDown={pointerDownFor?.({ kind: "group", group })}
        onClick={onNavigate}
        className={cn(dense ? ROW_DENSE : ROW_CLASS, rowSurface(dense, active), phase === "lifted" && "opacity-40", phase === "landing" && "opacity-0")}
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
 * Desktop: the name (14/20, medium) and the last message (13/18, secondary
 * grey), the reference app's `body1` and `body2`. An unread steps up one
 * notch, to the primary text.
 */
function RowTitle({ name, preview, unread }: { name: string; preview: string; unread?: boolean }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-[14px] leading-5 font-medium text-text-primary">{name}</span>
      <span className={cn("truncate text-[13px] leading-[18px]", unread ? "text-text-primary" : "text-text-secondary")}>{preview}</span>
    </span>
  );
}

/** « Renommer le chat »: the row becomes a field, Enter confirms, Escape cancels. */
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

