import type { ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  RiCustomerService2Line,
  RiHome5Line,
  RiInboxLine,
  RiSettings3Line,
} from "@remixicon/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useSecondaryReadsReady } from "../../lib/shell/after-first-paint";
import { useOpenSettings } from "../../lib/shell/settings-overlay";
import { useSupportDeskAvailable } from "../../lib/support/support-desk-availability";
import { useSupportUnread } from "../../lib/support/support-watch";
import { useRuntimeHealth } from "../../lib/runtime/use-runtime-health";
import { SupportUnreadDot } from "../support/support-unread-dot";
import { AccountMenu } from "./account-menu";
import { RailRuntimeHealth } from "./rail-runtime-health";

/**
 * Variante C (`lib/shell/account-layout.ts`, choisie dans Réglages > Apparence), bureau seulement : la coque
 * en rail. Un rail d'icônes posé sur le fond du cadre : Accueil, À traiter
 * en haut ; l'état du runtime, Support, Réglages et le compte en bas.
 */

/** 36 px, icône de 18 px, pas de 42 px entre deux boutons (gap 6). */
const RAIL_BUTTON =
  "relative inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-icon-secondary outline-none transition-colors duration-150 hover:bg-board-row-hover hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring aria-[current=page]:bg-background-secondary-default aria-[current=page]:text-foreground-icon-primary motion-reduce:transition-none [&>svg]:size-[18px]";

function RailTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function BoardIconRail() {
  const { t, plural } = useT();
  const navigate = useNavigate();
  const openSettings = useOpenSettings();
  const supportUnread = useSupportUnread();
  const deskAvailable = useSupportDeskAvailable();
  const secondaryReady = useSecondaryReadsReady();
  // Same read as the top bar badge on a thread: one `GET /api/runtime` entry.
  const runtimeHealth = useRuntimeHealth();
  // Le même relevé que la barre latérale : une seule requête en cache.
  const inboxCount = useQuery({
    queryKey: queryKeys.inbox,
    queryFn: api.inbox,
    refetchInterval: 120_000,
    refetchOnReconnect: true,
    enabled: secondaryReady,
    select: (inbox) => inbox.counts.total,
  }).data ?? 0;
  const supportLabel = supportUnread > 0
    ? plural(supportUnread, {
        one: t("support.launcherOpenUnread_one"),
        other: t("support.launcherOpenUnread_other"),
      })
    : t("boardui.support");
  const inboxLabel = inboxCount > 0 ? `${t("inbox.title")}: ${t("inbox.badge", { count: inboxCount })}` : t("inbox.title");

  return (
    <aside data-board-icon-rail="" aria-label={t("appSidebar.primaryNav")} className="hidden h-full min-h-0 w-14 shrink-0 flex-col items-center pb-3 md:flex">
      {/* La rangée du logo a la hauteur de la barre du haut (46 px). Dans la
          coque macOS, les feux la recouvrent : le logo passe dans la barre du
          haut (`native-titlebar.css`). */}
      <div data-titlebar-rail-logo="" className="flex h-[46px] shrink-0 items-center justify-center">
        <img src="/brand/ohb-icon.webp" alt="openedbot" className="size-7 shrink-0 object-contain" />
      </div>
      <nav className="flex shrink-0 flex-col items-center gap-1.5">
        <RailTip label={t("overviewPlaceholder.nav")}>
          <Link to="/" activeOptions={{ exact: true }} aria-label={t("overviewPlaceholder.nav")} className={RAIL_BUTTON}>
            <RiHome5Line aria-hidden />
          </Link>
        </RailTip>
        <RailTip label={t("inbox.title")}>
          <Link to="/inbox" aria-label={inboxLabel} className={RAIL_BUTTON}>
            <RiInboxLine aria-hidden />
            {inboxCount > 0 ? (
              // Le même repère que la pastille du Support, en bas du rail
              // (`SupportUnreadDot`) : un compteur à traiter, pas une étiquette.
              <span aria-hidden className="pointer-events-none absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[11px] font-medium leading-none text-primary-foreground tabular-nums ring-2 ring-background">
                {inboxCount > 99 ? "99+" : inboxCount}
              </span>
            ) : null}
          </Link>
        </RailTip>
      </nav>
      <div className="flex-1" />
      <nav aria-label={t("boardui.accountMenu", { name: t("navUser.operator") })} className="flex shrink-0 flex-col items-center gap-1.5">
        <RailRuntimeHealth reading={runtimeHealth} buttonClassName={RAIL_BUTTON} onOpenSettings={openSettings} />
        {deskAvailable ? (
          <RailTip label={supportLabel}>
            <button type="button" aria-label={supportLabel} className={RAIL_BUTTON} onClick={() => void navigate({ to: "/support/{-$conversationId}", params: {} })}>
              <RiCustomerService2Line aria-hidden />
              <SupportUnreadDot count={supportUnread} className="-top-1 -right-1" />
            </button>
          </RailTip>
        ) : null}
        <RailTip label={t("navUser.settings")}>
          <button type="button" aria-label={t("navUser.settings")} className={RAIL_BUTTON} onClick={() => openSettings()}>
            <RiSettings3Line aria-hidden />
          </button>
        </RailTip>
        <div className="mt-1.5">
          <AccountMenu variant="rail" side="right" align="end" />
        </div>
      </nav>
    </aside>
  );
}
