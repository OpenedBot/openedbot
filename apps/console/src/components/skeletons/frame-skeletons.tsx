import {
  RiAddFill,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiHome5Line,
  RiInboxLine,
  RiSearchLine,
  RiSettings3Line,
  RiSideBarLine,
} from "@remixicon/react";
import { IconServerBolt } from "@tabler/icons-react";
import { Skeleton, SkeletonListRow, SkeletonRegion, useIsMobile } from "@openedbot/browser-ui-kit";
import { Loader2 } from "lucide-react";
import { activeOwnFleetHint } from "../../pro-console/slots";
import { useT } from "../../lib/i18n";
import { readBootIdentityLabel } from "../../lib/session/boot-identity";
import { readCloudSession } from "../../lib/session/cloud-session";
import { BotFace } from "../bot-face";
import { fleetAccountInPath, fleetInPath } from "../../lib/workspace/workspace-location";
import { isConversationPath, readBootSidebarShape, type BootSidebarShape } from "../../lib/session/boot-shape";
import { BAR_ICON_BUTTON, TitlebarLogo, useBoardChrome } from "../boardui/board-chrome";
import { useAccountLayout } from "../../lib/shell/account-layout";
import { ConversationBodySkeleton, HeaderActionsSkeleton, HeaderTitleSkeleton } from "../thread-skeleton";
import { RAIL_BUTTON, RAIL_DIVIDER } from "../boardui/board-rails";
import { RailLlmQuotasLoading } from "../boardui/rail-llm-quotas";
import { SettingsPage, SettingsPageSidebar } from "../boardui/settings-modal";
import { isSettingsEntryActive, SETTINGS_GROUPS } from "../dashboard/settings-sidebar";
import { settingsBodySkeletonFor } from "../../screens/settings/settings-skeletons";

/**
 * Loading states of the app frame. Their geometry is the real one
 * (`BoardFrame`, `BoardTopBar`, `BoardSidebar`) and the HTML silhouette of
 * `index.html` draws the same: a refresh goes silhouette, then this frame,
 * then the screen, without anything moving. Change them together.
 *
 * Only what depends on data pulses: roster rows, pinned tiles, section
 * labels, the organization, the bot's name and the header's data actions.
 * The decor (tool buttons, Salon and Inbox links, bar icons) is painted as it
 * will be.
 */
/** Le gris des surfaces BoardUI absorbe `--muted` : un cran plus sombre (`skeleton.tsx`). */
const ON_SURFACE = "[--skeleton:var(--bui-background-tertiary-default)]";

/** `ROW_DENSE` and `SECTION_LABEL_DENSE` of `board-sidebar.tsx`. */
const DENSE_ROW = "h-[54px] p-2";
const DENSE_FACE = "size-9";

/** A pinned tile (`PIN_TILE`, 7.25rem): the 64 px face, then the name. */
function PinTileSkeleton() {
  return (
    <div className="flex w-[7.25rem] flex-col items-center gap-1.5 px-1 py-1.5">
      <Skeleton className="size-16 rounded-full" />
      <Skeleton className="h-3.5 w-16" />
    </div>
  );
}

/** The desktop roster, drawn from the shape the last loaded roster left (`lib/session/boot-shape.ts`). */
function RosterShape({ shape }: { shape: BootSidebarShape }) {
  return (
    <>
      {shape.pins > 0 ? (
        <div className="flex shrink-0 flex-wrap justify-center gap-3 px-1 pt-2 pb-3">
          {Array.from({ length: shape.pins }, (_, index) => <PinTileSkeleton key={index} />)}
        </div>
      ) : null}
      {shape.blocks.map((block, blockIndex) => (
        <div key={blockIndex} className="flex shrink-0 flex-col gap-0.5">
          {block.label ? (
            <div className="flex h-[30px] shrink-0 items-center px-2 pt-2 pb-1.5"><Skeleton className="h-3 w-16" /></div>
          ) : null}
          {Array.from({ length: block.rows }, (_, index) => (
            <SkeletonListRow key={index} className={DENSE_ROW} avatarClassName={DENSE_FACE} />
          ))}
        </div>
      ))}
    </>
  );
}

export function RosterSkeleton({ label, rows = 5, dense = false }: { label: string; rows?: number; dense?: boolean }) {
  return (
    <SkeletonRegion label={label} className={`flex flex-col ${dense ? "gap-1" : "gap-2"} ${ON_SURFACE}`}>
      {dense
        ? <RosterShape shape={readBootSidebarShape()} />
        : Array.from({ length: rows }, (_, index) => <SkeletonListRow key={index} />)}
    </SkeletonRegion>
  );
}

const TOP_TOOL = "flex h-9 items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-secondary";
/** `NAV_ROW` of `board-sidebar.tsx`, without its states. */
const NAV_ROW = "flex h-8 items-center gap-2.5 px-2.5 text-[13px] leading-[18px] font-medium text-text-primary [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-foreground-icon-secondary";

/**
 * Variante C (`BoardIconRail` de board-rails.tsx) : le rail de 56 px, logo à
 * la hauteur de la barre du haut, Salon et À traiter en haut ; en bas, les
 * quotas LLM en chargement (`RailLlmQuotasLoading`, les trois places que la
 * première lecture remplit), le runtime (pastille neutre, comme pendant sa
 * première lecture), puis Réglages. Le Support dépend de données : il
 * apparaît en dessous, le bas du rail est ancré.
 */
function RailSkeleton() {
  const icon = `${RAIL_BUTTON} pointer-events-none`;
  return (
    <div aria-hidden data-board-icon-rail="" className={`flex h-full min-h-0 w-14 shrink-0 flex-col items-center pb-3 ${ON_SURFACE}`}>
      <div data-titlebar-rail-logo="" className="flex h-[46px] shrink-0 items-center justify-center">
        <img src="/brand/ohb-icon.webp" alt="" className="size-7 shrink-0 object-contain" />
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1.5">
        <span className={icon}><RiHome5Line /></span>
        <span className={icon}><RiInboxLine /></span>
      </div>
      <div className="flex-1" />
      <div className="flex shrink-0 flex-col items-center gap-1.5">
        <RailLlmQuotasLoading buttonClassName={RAIL_BUTTON} />
        <span className={icon}>
          <IconServerBolt />
          <span className="absolute right-1 bottom-1 inline-flex size-2.5">
            <span className="relative size-2.5 rounded-full bg-muted-foreground/30 ring-2 ring-background" />
          </span>
        </span>
        <span className={RAIL_DIVIDER} />
        <span className={icon}><RiSettings3Line /></span>
      </div>
    </div>
  );
}

function SidebarSkeleton({ railShell }: { railShell: boolean }) {
  const { t } = useT();
  return (
    <div className={`isolate flex h-full min-h-0 w-[272px] shrink-0 flex-col ${railShell ? "" : "ps-3 "}pb-3 ${ON_SURFACE}`}>
      {/* La carte grise de la barre (`BOARD_SIDEBAR_CARD`, board-sidebar.tsx). */}
      <div className="flex min-h-0 flex-1 flex-col rounded-3xl border border-border-button-white bg-background-secondary-default p-[7px]">
        {railShell ? (
          // Variante C : la recherche permanente et le « + », sans liens.
          <div aria-hidden data-sidebar-tools="" className="flex shrink-0 items-center gap-2">
            <span className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-background-tertiary-default ps-2.5 text-foreground-icon-tertiary">
              <RiSearchLine className="size-4 shrink-0" />
              <span className="truncate text-body-2-medium text-text-tertiary">{t("boardui.searchPlaceholder")}</span>
            </span>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-secondary">
              <RiAddFill className="size-[18px]" />
            </span>
          </div>
        ) : (<>
        <div data-sidebar-tools="" className="flex shrink-0">
          <div aria-hidden className="grid h-9 min-w-0 flex-1 grid-cols-3 gap-2">
            <span className={TOP_TOOL}><RiSearchLine className="size-5" /></span>
            <span />
            <span className="flex h-9 items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-secondary">
              <RiAddFill className="size-5" />
            </span>
          </div>
        </div>
        <div aria-hidden data-sidebar-nav="" className="mt-3 flex shrink-0 flex-col gap-px">
          <span className={NAV_ROW}><RiHome5Line /><span className="truncate">{t("overviewPlaceholder.nav")}</span></span>
          <span className={NAV_ROW}><RiInboxLine /><span className="truncate">{t("inbox.title")}</span></span>
        </div>
        </>)}
        <div className="mt-1 flex min-h-0 flex-1 flex-col gap-1 overflow-hidden">
          <RosterShape shape={readBootSidebarShape()} />
        </div>
        {/* Variante C : le compte est dans le rail, pas en pied de liste. */}
        {railShell ? null : (
          <div className="mt-1.5 shrink-0">
            <SkeletonListRow className="h-[50px] px-2.5 py-2" avatarClassName="size-[26px]" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * `BoardTopBar`: the organization, the sidebar toggle, back and forward, then
 * on a conversation the breadcrumb (`Salon > face name`) and its actions.
 * With the sidebar folded, its search and `+` move up here.
 */
function TopBarSkeleton({ conversation, organization, title }: {
  conversation: boolean;
  organization: boolean;
  /** Le titre connu d'avance (une rubrique des réglages) : « Salon › titre », comme `BoardHeader`. */
  title?: string | null;
}) {
  const { t } = useT();
  const collapsed = useBoardChrome((state) => state.collapsed);
  const bootLabel = readBootIdentityLabel(readCloudSession()?.userId);
  return (
    <div data-titlebar-drag="" className="relative flex h-[46px] shrink-0 items-center gap-1 ps-3 pe-3">
      <div aria-hidden data-titlebar-lights="" />
      <TitlebarLogo />
      {collapsed || !organization ? null : (
        <span aria-hidden className="flex h-[30px] items-center gap-2 px-1.5">
          {/* The fixed organization face and the label recorded on the last
              visit (`lib/session/boot-identity.ts`): only an unknown label pulses. */}
          <BotFace name="openedbot" seed="ohb-organization" face={null} animated={false} className="size-[18px] shrink-0" />
          {bootLabel
            ? <span className="truncate text-body-2-medium font-semibold text-text-primary">{bootLabel}</span>
            : <Skeleton className="h-3.5 w-16" />}
        </span>
      )}
      <span aria-hidden className={BAR_ICON_BUTTON}><RiSideBarLine className="size-[18px]" /></span>
      {collapsed ? (
        <span aria-hidden className="flex items-center gap-1">
          <span className={BAR_ICON_BUTTON}><RiSearchLine className="size-[18px]" /></span>
          <span className="ms-1 inline-flex size-[30px] items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-secondary">
            <RiAddFill className="size-[18px]" />
          </span>
          <span className="ms-2 me-1 h-[18px] w-px bg-border-button-default" />
        </span>
      ) : null}
      <span aria-hidden className="flex items-center opacity-35">
        <span className={BAR_ICON_BUTTON}><RiArrowLeftSLine className="size-[18px]" /></span>
        <span className={BAR_ICON_BUTTON}><RiArrowRightSLine className="size-[18px]" /></span>
      </span>
      {conversation ? (
        /* `ConversationHeader` : le titre seul, centré sur la barre dès `xl`
           (`BoardHeader centered`), les actions à droite. */
        <>
          <span aria-hidden className="flex min-w-0 flex-1 items-center px-1 xl:absolute xl:top-1/2 xl:left-1/2 xl:max-w-[30%] xl:flex-none xl:-translate-x-1/2 xl:-translate-y-1/2">
            <span className="flex h-[30px] min-w-0 items-center px-1.5"><HeaderTitleSkeleton /></span>
          </span>
          <HeaderActionsSkeleton />
        </>
      ) : title ? (
        <span aria-hidden className="flex min-w-0 flex-1 items-center gap-1.5 px-1">
          <span className="shrink-0 px-1 text-body-2-medium whitespace-nowrap text-text-secondary">{t("overviewPlaceholder.nav")}</span>
          <span className="shrink-0 text-text-tertiary">›</span>
          <span className="flex h-[30px] min-w-0 items-center gap-2 px-1.5 text-body-2-medium font-semibold text-text-primary">
            <span className="min-w-0 truncate">{title}</span>
          </span>
        </span>
      ) : null}
    </div>
  );
}

/** Le chemin interne d'une rubrique des réglages (`/settings/...`), ou `null` hors des réglages. */
export function settingsPathOf(pathname: string): string | null {
  const internal = pathname.replace(/^\/o\/[^/]+/, "").replace(/\/+$/, "") || "/";
  return internal === "/settings" || internal.startsWith("/settings/") ? internal : null;
}

/**
 * The agency frame outline (`FleetFrame`), drawn from the address alone: the
 * top bar, the 272 px client list with its health card, and an
 * empty main card that spins. No data, no query, so it paints on a cold load
 * before the account workspaces are known.
 */
export function FleetFrameSkeleton() {
  const { t } = useT();
  return (
    <SkeletonRegion
      label={t("common.loading")}
      className={`flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden bg-background-full ${ON_SURFACE}`}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-[46px] shrink-0 items-center gap-3 ps-3 pe-3">
          <span aria-hidden className="flex h-[30px] items-center gap-2 px-1.5">
            <Skeleton className="size-[18px] rounded-full" />
            <Skeleton className="h-3.5 w-20" />
          </span>
          <Skeleton className="h-3.5 w-24" />
          <span aria-hidden className="flex flex-1 justify-center"><Skeleton className="h-8 w-72 max-w-full rounded-full" /></span>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1">
          <aside className="flex h-full min-h-0 w-[272px] shrink-0 flex-col ps-3 pb-3">
            <div className="flex min-h-0 flex-1 flex-col rounded-3xl border border-border-button-white bg-background-secondary-default p-[7px]">
              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden">
                {Array.from({ length: 5 }, (_, index) => (
                  <div key={index} className={`flex items-center gap-2.5 ${DENSE_ROW}`}>
                    <Skeleton className="size-2.5 rounded-full" />
                    <Skeleton className="h-3.5 flex-1" />
                  </div>
                ))}
              </div>
              <Skeleton className="mt-1.5 h-[72px] shrink-0 rounded-2xl" />
            </div>
          </aside>
          <div className="flex min-h-0 min-w-0 flex-1 ps-3 pe-3 pb-3">
            <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background-full">
              <Loader2 className="size-6 animate-spin text-foreground-icon-tertiary motion-reduce:animate-none" aria-hidden />
            </div>
          </div>
        </div>
      </div>
    </SkeletonRegion>
  );
}

/**
 * Le cadre entier pendant les gardes de `_app` (session, organisation,
 * accueil) : au bureau la barre du haut, la carte de la barre latérale et la
 * carte principale de `BoardFrame`, sur téléphone la scène seule, comme
 * `MobileFrame` qui range la barre dans son tiroir. Sur une conversation, la
 * carte principale porte déjà le fil et le composer.
 */
export function AppFrameSkeleton() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const collapsed = useBoardChrome((state) => state.collapsed);
  // The address bar, like `index.html`: this frame shows while the guards of
  // the first load resolve, before the router has committed a location.
  const pathname = globalThis.location?.pathname ?? "";
  const conversation = isConversationPath(pathname);
  const railShell = useAccountLayout() === "c";
  // Une rubrique des réglages est une page du cadre : son menu à la place de
  // la barre des conversations, son titre dans la barre, son corps dans la carte.
  const settingsPath = settingsPathOf(pathname);
  const settingsItem = settingsPath
    ? SETTINGS_GROUPS.flatMap((group) => group.items).find((item) =>
      isSettingsEntryActive(settingsPath, item.url, item.exact)
      || (item.also ?? []).some((url) => isSettingsEntryActive(settingsPath, url)))
    : undefined;
  const SettingsBody = settingsPath ? settingsBodySkeletonFor(settingsPath) : null;
  // A client address of an agency, the agency's own team and profile pages, or
  // a shared address (`/support`) while an agency is the active organization,
  // draw the agency frame, not the personal one.
  if (!isMobile && (fleetInPath(pathname) || fleetAccountInPath(pathname) || activeOwnFleetHint())) return <FleetFrameSkeleton />;
  if (isMobile) {
    return (
      <SkeletonRegion
        label={t("common.loading")}
        className="flex h-full min-h-0 w-full flex-1 flex-col bg-background-secondary-default"
      />
    );
  }
  return (
    <SkeletonRegion
      label={t("common.loading")}
      className="flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden bg-background-full"
    >
      {railShell ? <RailSkeleton /> : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBarSkeleton
          conversation={conversation}
          organization={!railShell}
          title={settingsItem ? t(settingsItem.titleKey) : null}
        />
        <div className="flex min-h-0 min-w-0 flex-1">
          {settingsPath ? <SettingsPageSidebar signOut={false} /> : collapsed ? null : <SidebarSkeleton railShell={railShell} />}
          <div className="flex min-h-0 min-w-0 flex-1 px-3 pb-3">
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-clip rounded-3xl bg-background-secondary-default">
              {conversation ? <ConversationBodySkeleton /> : null}
              {SettingsBody ? <SettingsPage><SettingsBody /></SettingsPage> : null}
            </div>
          </div>
        </div>
      </div>
    </SkeletonRegion>
  );
}
